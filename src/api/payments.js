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
