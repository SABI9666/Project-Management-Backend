// src/api/invoices.js - Invoice Management API with AWS DynamoDB
const express = require('express');
const { verifyToken } = require('../middleware/auth');
const { 
    getItem, 
    putItem, 
    updateItem, 
    deleteItem,
    queryByIndex, 
    scanTable,
    generateId,
    timestamp 
} = require('../utils/dynamodb');
const { sendNotificationEmail } = require('../utils/email');

const router = express.Router();
router.use(verifyToken);

// ============================================
// POST /api/invoices - Create invoice
// ============================================
router.post('/', async (req, res) => {
    try {
        // Only COO/Director can create invoices
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director can create invoices'
            });
        }

        const {
            projectId,
            invoiceNo,
            amount,
            currency,
            dueDate,
            items,
            notes,
            clientName,
            clientEmail,
            clientAddress
        } = req.body;

        if (!projectId || !amount || !dueDate) {
            return res.status(400).json({
                success: false,
                error: 'Project ID, amount, and due date are required'
            });
        }

        const project = await getItem(process.env.PROJECTS_TABLE, { id: projectId });
        if (!project) {
            return res.status(404).json({
                success: false,
                error: 'Project not found'
            });
        }

        const invoiceId = generateId();
        const invoiceNumber = invoiceNo || `INV-${Date.now().toString().slice(-8)}`;

        const invoiceData = {
            id: invoiceId,
            invoiceNo: invoiceNumber,
            projectId,
            projectName: project.projectName,
            projectCode: project.projectCode,
            
            amount: parseFloat(amount),
            currency: currency || project.currency || 'USD',
            
            dueDate: typeof dueDate === 'number' ? dueDate : parseInt(dueDate),
            issueDate: timestamp(),
            
            items: items || [],
            notes: notes || '',
            
            clientName: clientName || project.clientCompany,
            clientEmail: clientEmail || project.clientEmail,
            clientAddress: clientAddress || '',
            
            status: 'draft', // draft, sent, paid, overdue, cancelled
            
            paidAmount: 0,
            paidDate: null,
            
            createdBy: req.user.name,
            createdByUid: req.user.uid,
            createdAt: timestamp(),
            updatedAt: timestamp()
        };

        await putItem(process.env.INVOICES_TABLE, invoiceData);

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'invoice_created',
            details: `Invoice ${invoiceNumber} created for ${project.projectName}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId,
            invoiceId
        });

        return res.status(201).json({
            success: true,
            message: 'Invoice created successfully',
            data: invoiceData
        });

    } catch (error) {
        console.error('Create invoice error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to create invoice',
            message: error.message
        });
    }
});

// ============================================
// GET /api/invoices - List invoices
// ============================================
router.get('/', async (req, res) => {
    try {
        const { projectId, status, id } = req.query;

        // Get single invoice
        if (id) {
            const invoice = await getItem(process.env.INVOICES_TABLE, { id });
            
            if (!invoice) {
                return res.status(404).json({
                    success: false,
                    error: 'Invoice not found'
                });
            }

            return res.status(200).json({
                success: true,
                data: invoice
            });
        }

        let invoices = [];

        // Query by project
        if (projectId) {
            invoices = await queryByIndex(
                process.env.INVOICES_TABLE,
                'projectId-index',
                {
                    expression: 'projectId = :projectId',
                    values: { ':projectId': projectId }
                }
            );
        }
        // List all (admin only)
        else {
            if (!['coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({
                    success: false,
                    error: 'Insufficient permissions'
                });
            }
            invoices = await scanTable(process.env.INVOICES_TABLE);
        }

        // Filter by status
        if (status) {
            invoices = invoices.filter(i => i.status === status);
        }

        // Update overdue status
        const now = timestamp();
        for (const invoice of invoices) {
            if (invoice.status === 'sent' && invoice.dueDate < now) {
                invoice.status = 'overdue';
                await updateItem(
                    process.env.INVOICES_TABLE,
                    { id: invoice.id },
                    { status: 'overdue' }
                );
            }
        }

        // Sort by issue date (newest first)
        invoices.sort((a, b) => b.issueDate - a.issueDate);

        return res.status(200).json({
            success: true,
            data: invoices,
            count: invoices.length
        });

    } catch (error) {
        console.error('List invoices error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch invoices',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/invoices/:id/send - Send invoice
// ============================================
router.put('/:id/send', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director can send invoices'
            });
        }

        const { id } = req.params;
        const invoice = await getItem(process.env.INVOICES_TABLE, { id });

        if (!invoice) {
            return res.status(404).json({
                success: false,
                error: 'Invoice not found'
            });
        }

        if (invoice.status === 'paid') {
            return res.status(400).json({
                success: false,
                error: 'Invoice is already paid'
            });
        }

        // Update status
        await updateItem(
            process.env.INVOICES_TABLE,
            { id },
            {
                status: 'sent',
                sentDate: timestamp(),
                updatedAt: timestamp()
            }
        );

        // Send email to client
        if (invoice.clientEmail) {
            await sendNotificationEmail(
                [invoice.clientEmail],
                'invoiceGenerated',
                {
                    invoiceNo: invoice.invoiceNo,
                    projectName: invoice.projectName,
                    amount: invoice.amount,
                    currency: invoice.currency,
                    dueDate: new Date(invoice.dueDate * 1000).toLocaleDateString(),
                    loginUrl: process.env.FRONTEND_URL
                }
            );
        }

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'invoice_sent',
            details: `Invoice ${invoice.invoiceNo} sent to client`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: invoice.projectId,
            invoiceId: id
        });

        return res.status(200).json({
            success: true,
            message: 'Invoice sent successfully'
        });

    } catch (error) {
        console.error('Send invoice error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to send invoice',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/invoices/:id/mark-paid - Mark invoice as paid
// ============================================
router.put('/:id/mark-paid', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director can mark invoices as paid'
            });
        }

        const { id } = req.params;
        const { paidAmount, paidDate, paymentMethod, notes } = req.body;

        const invoice = await getItem(process.env.INVOICES_TABLE, { id });

        if (!invoice) {
            return res.status(404).json({
                success: false,
                error: 'Invoice not found'
            });
        }

        if (invoice.status === 'paid') {
            return res.status(400).json({
                success: false,
                error: 'Invoice is already marked as paid'
            });
        }

        const amountPaid = paidAmount ? parseFloat(paidAmount) : invoice.amount;

        // Update invoice
        await updateItem(
            process.env.INVOICES_TABLE,
            { id },
            {
                status: 'paid',
                paidAmount: amountPaid,
                paidDate: paidDate || timestamp(),
                paymentMethod: paymentMethod || 'bank_transfer',
                paymentNotes: notes || '',
                updatedAt: timestamp()
            }
        );

        // Create payment record
        await putItem(process.env.PAYMENTS_TABLE, {
            id: generateId(),
            projectId: invoice.projectId,
            projectName: invoice.projectName,
            invoiceNo: invoice.invoiceNo,
            invoiceId: id,
            amount: amountPaid,
            currency: invoice.currency,
            paymentDate: paidDate || timestamp(),
            paymentMethod: paymentMethod || 'bank_transfer',
            notes: notes || '',
            recordedBy: req.user.name,
            recordedByUid: req.user.uid,
            createdAt: timestamp()
        });

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'invoice_paid',
            details: `Invoice ${invoice.invoiceNo} marked as paid`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: invoice.projectId,
            invoiceId: id
        });

        return res.status(200).json({
            success: true,
            message: 'Invoice marked as paid'
        });

    } catch (error) {
        console.error('Mark paid error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to mark invoice as paid',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/invoices/:id - Update invoice
// ============================================
router.put('/:id', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director can update invoices'
            });
        }

        const { id } = req.params;
        const invoice = await getItem(process.env.INVOICES_TABLE, { id });

        if (!invoice) {
            return res.status(404).json({
                success: false,
                error: 'Invoice not found'
            });
        }

        if (invoice.status === 'paid') {
            return res.status(400).json({
                success: false,
                error: 'Cannot edit paid invoices'
            });
        }

        const updates = {
            ...req.body,
            updatedAt: timestamp()
        };

        // Remove protected fields
        delete updates.id;
        delete updates.invoiceNo;
        delete updates.projectId;
        delete updates.status;
        delete updates.createdAt;
        delete updates.createdBy;

        const updatedInvoice = await updateItem(
            process.env.INVOICES_TABLE,
            { id },
            updates
        );

        return res.status(200).json({
            success: true,
            message: 'Invoice updated successfully',
            data: updatedInvoice
        });

    } catch (error) {
        console.error('Update invoice error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to update invoice',
            message: error.message
        });
    }
});

// ============================================
// DELETE /api/invoices/:id - Delete invoice
// ============================================
router.delete('/:id', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director can delete invoices'
            });
        }

        const { id } = req.params;
        const invoice = await getItem(process.env.INVOICES_TABLE, { id });

        if (!invoice) {
            return res.status(404).json({
                success: false,
                error: 'Invoice not found'
            });
        }

        if (invoice.status === 'paid') {
            return res.status(400).json({
                success: false,
                error: 'Cannot delete paid invoices'
            });
        }

        await deleteItem(process.env.INVOICES_TABLE, { id });

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'invoice_deleted',
            details: `Invoice ${invoice.invoiceNo} deleted`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: invoice.projectId
        });

        return res.status(200).json({
            success: true,
            message: 'Invoice deleted successfully'
        });

    } catch (error) {
        console.error('Delete invoice error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to delete invoice',
            message: error.message
        });
    }
});

// ============================================
// GET /api/invoices/overdue - Get overdue invoices
// ============================================
router.get('/overdue', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions'
            });
        }

        const invoices = await scanTable(process.env.INVOICES_TABLE);
        const now = timestamp();

        const overdueInvoices = invoices.filter(inv => 
            inv.status === 'sent' && inv.dueDate < now
        );

        // Update status to overdue
        for (const invoice of overdueInvoices) {
            await updateItem(
                process.env.INVOICES_TABLE,
                { id: invoice.id },
                { status: 'overdue' }
            );
            invoice.status = 'overdue';

            // Calculate days overdue
            const daysOverdue = Math.floor((now - invoice.dueDate) / (60 * 60 * 24));
            invoice.daysOverdue = daysOverdue;
        }

        return res.status(200).json({
            success: true,
            data: overdueInvoices,
            count: overdueInvoices.length
        });

    } catch (error) {
        console.error('Get overdue invoices error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch overdue invoices',
            message: error.message
        });
    }
});

module.exports = router;
