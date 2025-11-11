// src/api/deliverables.js - Deliverables API with AWS DynamoDB + S3
const express = require('express');
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');
const { uploadFile, getSignedUrl, deleteFile } = require('../utils/s3');
const { 
    getItem, putItem, updateItem, deleteItem,
    queryByIndex, generateId, timestamp 
} = require('../utils/dynamodb');
const { sendNotificationEmail } = require('../utils/email');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
router.use(verifyToken);

// POST /api/deliverables - Create deliverable
router.post('/', async (req, res) => {
    try {
        const { projectId, name, description, dueDate, type } = req.body;
        
        if (!projectId || !name) {
            return res.status(400).json({ success: false, error: 'Project ID and name required' });
        }

        const project = await getItem(process.env.PROJECTS_TABLE, { id: projectId });
        if (!project) {
            return res.status(404).json({ success: false, error: 'Project not found' });
        }

        const canCreate = req.user.role === 'coo' || project.designLeadUid === req.user.uid;
        if (!canCreate) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const deliverableId = generateId();
        const deliverableData = {
            id: deliverableId,
            projectId, projectName: project.projectName,
            name, description: description || '',
            type: type || 'document',
            dueDate: dueDate || null,
            status: 'pending', // pending, submitted, approved, rejected
            files: [],
            submittedBy: null, submittedAt: null,
            reviewedBy: null, reviewedAt: null, reviewNotes: null,
            createdBy: req.user.name, createdByUid: req.user.uid,
            createdAt: timestamp(), updatedAt: timestamp()
        };

        await putItem(process.env.DELIVERABLES_TABLE, deliverableData);

        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(), type: 'deliverable_created',
            details: `Deliverable "${name}" created for ${project.projectName}`,
            performedByName: req.user.name, performedByUid: req.user.uid,
            timestamp: timestamp(), projectId
        });

        return res.status(201).json({ success: true, data: deliverableData });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/deliverables - List deliverables
router.get('/', async (req, res) => {
    try {
        const { projectId, status, id } = req.query;

        if (id) {
            const deliverable = await getItem(process.env.DELIVERABLES_TABLE, { id });
            if (!deliverable) {
                return res.status(404).json({ success: false, error: 'Not found' });
            }
            
            // Generate signed URLs for files
            if (deliverable.files && deliverable.files.length > 0) {
                deliverable.files = await Promise.all(
                    deliverable.files.map(async (file) => ({
                        ...file,
                        url: await getSignedUrl(file.s3Key, 3600)
                    }))
                );
            }
            
            return res.status(200).json({ success: true, data: deliverable });
        }

        let deliverables = [];
        
        if (projectId) {
            deliverables = await queryByIndex(process.env.DELIVERABLES_TABLE, 'projectId-index', {
                expression: 'projectId = :projectId', values: { ':projectId': projectId }
            });
        } else if (['coo', 'director'].includes(req.user.role)) {
            deliverables = await scanTable(process.env.DELIVERABLES_TABLE);
        } else {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        if (status) deliverables = deliverables.filter(d => d.status === status);
        deliverables.sort((a, b) => b.createdAt - a.createdAt);

        return res.status(200).json({ success: true, data: deliverables });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/deliverables/:id/submit - Submit deliverable with files
router.post('/:id/submit', upload.array('files', 5), async (req, res) => {
    try {
        const { id } = req.params;
        const deliverable = await getItem(process.env.DELIVERABLES_TABLE, { id });
        
        if (!deliverable) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        if (deliverable.status !== 'pending') {
            return res.status(400).json({ success: false, error: 'Already submitted' });
        }

        const uploadedFiles = [];
        
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const s3Result = await uploadFile(
                    file.buffer, file.originalname, file.mimetype,
                    `deliverables/${id}`
                );
                
                uploadedFiles.push({
                    fileName: file.originalname,
                    fileSize: file.size,
                    mimeType: file.mimetype,
                    s3Key: s3Result.key,
                    uploadedAt: timestamp()
                });
            }
        }

        await updateItem(process.env.DELIVERABLES_TABLE, { id }, {
            status: 'submitted',
            files: uploadedFiles,
            submittedBy: req.user.name,
            submittedAt: timestamp(),
            updatedAt: timestamp()
        });

        await sendNotificationEmail(
            [deliverable.createdBy],
            'deliverableSubmitted',
            {
                deliverableName: deliverable.name,
                projectName: deliverable.projectName,
                submittedBy: req.user.name,
                submissionDate: new Date().toLocaleDateString(),
                loginUrl: process.env.FRONTEND_URL
            }
        );

        return res.status(200).json({ success: true, message: 'Deliverable submitted' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/deliverables/:id/approve - Approve deliverable
router.put('/:id/approve', async (req, res) => {
    try {
        if (!['coo', 'director', 'design_manager'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const { id } = req.params;
        const { notes } = req.body;
        const deliverable = await getItem(process.env.DELIVERABLES_TABLE, { id });

        if (!deliverable) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        if (deliverable.status !== 'submitted') {
            return res.status(400).json({ success: false, error: 'Not submitted yet' });
        }

        await updateItem(process.env.DELIVERABLES_TABLE, { id }, {
            status: 'approved',
            reviewedBy: req.user.name,
            reviewedAt: timestamp(),
            reviewNotes: notes || null,
            updatedAt: timestamp()
        });

        return res.status(200).json({ success: true, message: 'Deliverable approved' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/deliverables/:id/reject - Reject deliverable
router.put('/:id/reject', async (req, res) => {
    try {
        if (!['coo', 'director', 'design_manager'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const { id } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ success: false, error: 'Reason required' });
        }

        const deliverable = await getItem(process.env.DELIVERABLES_TABLE, { id });

        if (!deliverable) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        await updateItem(process.env.DELIVERABLES_TABLE, { id }, {
            status: 'rejected',
            reviewedBy: req.user.name,
            reviewedAt: timestamp(),
            reviewNotes: reason,
            updatedAt: timestamp()
        });

        return res.status(200).json({ success: true, message: 'Deliverable rejected' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/deliverables/:id - Delete deliverable
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deliverable = await getItem(process.env.DELIVERABLES_TABLE, { id });

        if (!deliverable) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        const canDelete = req.user.role === 'coo' || deliverable.createdByUid === req.user.uid;
        if (!canDelete) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        // Delete files from S3
        if (deliverable.files && deliverable.files.length > 0) {
            for (const file of deliverable.files) {
                await deleteFile(file.s3Key);
            }
        }

        await deleteItem(process.env.DELIVERABLES_TABLE, { id });

        return res.status(200).json({ success: true, message: 'Deliverable deleted' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;

═══════════════════════════════════════════════════════════════════
FILE 11: payments.js
═══════════════════════════════════════════════════════════════════

// src/api/payments.js - Payments API with AWS DynamoDB
const express = require('express');
const { verifyToken } = require('../middleware/auth');
const { 
    getItem, putItem, updateItem, deleteItem,
    queryByIndex, scanTable, generateId, timestamp, incrementField
} = require('../utils/dynamodb');
const { sendNotificationEmail } = require('../utils/email');

const router = express.Router();
router.use(verifyToken);

// POST /api/payments - Record payment
router.post('/', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const { projectId, amount, currency, paymentDate, paymentMethod, invoiceNo, notes } = req.body;

        if (!projectId || !amount) {
            return res.status(400).json({ success: false, error: 'Project ID and amount required' });
        }

        const project = await getItem(process.env.PROJECTS_TABLE, { id: projectId });
        if (!project) {
            return res.status(404).json({ success: false, error: 'Project not found' });
        }

        const paymentId = generateId();
        const paymentData = {
            id: paymentId, projectId,
            projectName: project.projectName,
            projectCode: project.projectCode,
            amount: parseFloat(amount),
            currency: currency || project.currency || 'USD',
            paymentDate: paymentDate || timestamp(),
            paymentMethod: paymentMethod || 'bank_transfer',
            invoiceNo: invoiceNo || null,
            notes: notes || '',
            recordedBy: req.user.name,
            recordedByUid: req.user.uid,
            createdAt: timestamp()
        };

        await putItem(process.env.PAYMENTS_TABLE, paymentData);

        // Update project total received
        await incrementField(process.env.PROJECTS_TABLE, { id: projectId }, 'totalReceived', parseFloat(amount));

        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(), type: 'payment_received',
            details: `Payment of ${currency} ${amount} received for ${project.projectName}`,
            performedByName: req.user.name, performedByUid: req.user.uid,
            timestamp: timestamp(), projectId
        });

        await sendNotificationEmail(
            [project.clientEmail],
            'paymentReceived',
            {
                projectName: project.projectName,
                invoiceNo: invoiceNo || 'N/A',
                amount, currency: currency || 'USD',
                paymentDate: new Date().toLocaleDateString(),
                paymentMethod: paymentMethod || 'Bank Transfer',
                loginUrl: process.env.FRONTEND_URL
            }
        );

        return res.status(201).json({ success: true, data: paymentData });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/payments - List payments
router.get('/', async (req, res) => {
    try {
        const { projectId, id } = req.query;

        if (id) {
            const payment = await getItem(process.env.PAYMENTS_TABLE, { id });
            return payment 
                ? res.status(200).json({ success: true, data: payment })
                : res.status(404).json({ success: false, error: 'Not found' });
        }

        let payments = [];

        if (projectId) {
            payments = await queryByIndex(process.env.PAYMENTS_TABLE, 'projectId-index', {
                expression: 'projectId = :projectId', values: { ':projectId': projectId }
            });
        } else if (['coo', 'director'].includes(req.user.role)) {
            payments = await scanTable(process.env.PAYMENTS_TABLE);
        } else {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        payments.sort((a, b) => b.paymentDate - a.paymentDate);
        return res.status(200).json({ success: true, data: payments });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/payments/overdue - Get overdue payments
router.get('/overdue', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const invoices = await scanTable(process.env.INVOICES_TABLE);
        const now = timestamp();
        
        const overdueInvoices = invoices.filter(inv => 
            inv.status !== 'paid' && inv.dueDate && inv.dueDate < now
        );

        return res.status(200).json({ success: true, data: overdueInvoices });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/payments/:id - Update payment
router.put('/:id', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const { id } = req.params;
        const payment = await getItem(process.env.PAYMENTS_TABLE, { id });

        if (!payment) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        const updates = { ...req.body, updatedAt: timestamp() };
        delete updates.id; delete updates.projectId; delete updates.createdAt;

        const updatedPayment = await updateItem(process.env.PAYMENTS_TABLE, { id }, updates);

        return res.status(200).json({ success: true, data: updatedPayment });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/payments/:id - Delete payment
router.delete('/:id', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const { id } = req.params;
        const payment = await getItem(process.env.PAYMENTS_TABLE, { id });

        if (!payment) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        await deleteItem(process.env.PAYMENTS_TABLE, { id });

        // Decrement project total
        await incrementField(process.env.PROJECTS_TABLE, { id: payment.projectId }, 'totalReceived', -payment.amount);

        return res.status(200).json({ success: true, message: 'Payment deleted' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
