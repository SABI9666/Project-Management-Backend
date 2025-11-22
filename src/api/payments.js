// src/api/payments.js - Payments API (FIXED for BDM access)
const express = require('express');
const { verifyToken } = require('../middleware/auth.js');
const { getItem, putItem, updateItem, scanTable, generateId, timestamp } = require('../utils/dynamodb');

const router = express.Router();
router.use(verifyToken);

// ============================================
// GET /api/payments - List payments (FIXED)
// ============================================
router.get('/', async (req, res) => {
    try {
        // ============================================
        // FIXED: Allow BDM to see payments
        // ============================================
        const allowedRoles = ['coo', 'director', 'bdm', 'accounts'];
        
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        // Get all payments
        let payments = await scanTable(process.env.PAYMENTS_TABLE || 'PMTrackerPayments');
        
        // Filter based on role
        if (req.user.role === 'bdm') {
            // BDM sees payments for their proposals
            const allProposals = await scanTable(process.env.PROPOSALS_TABLE);
            const myProposalIds = allProposals
                .filter(p => p.submittedByUid === req.user.uid)
                .map(p => p.id);
            
            payments = payments.filter(pay => myProposalIds.includes(pay.proposalId));
        }
        
        // Sort by date (newest first)
        payments.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        return res.status(200).json({
            success: true,
            data: payments
        });

    } catch (error) {
        console.error('Error in GET /payments:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// GET /api/payments/:id - Get single payment
// ============================================
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const payment = await getItem(process.env.PAYMENTS_TABLE || 'PMTrackerPayments', { id });
        
        if (!payment) {
            return res.status(404).json({
                success: false,
                error: 'Payment not found'
            });
        }

        // Check permissions
        const allowedRoles = ['coo', 'director', 'bdm', 'accounts'];
        
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        return res.status(200).json({
            success: true,
            data: payment
        });

    } catch (error) {
        console.error('Error in GET /payments/:id:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// POST /api/payments - Create payment record
// ============================================
router.post('/', async (req, res) => {
    try {
        // Only accounts, COO, and director can create payments
        const allowedRoles = ['coo', 'director', 'accounts'];
        
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Only accounts team can create payments'
            });
        }

        const {
            proposalId,
            projectId,
            amount,
            currency,
            paymentMethod,
            paymentDate,
            invoiceNumber,
            notes
        } = req.body;

        if (!amount || !proposalId) {
            return res.status(400).json({
                success: false,
                error: 'Amount and proposal ID are required'
            });
        }

        const paymentId = generateId();
        const paymentData = {
            id: paymentId,
            proposalId,
            projectId: projectId || null,
            amount: parseFloat(amount),
            currency: currency || 'USD',
            paymentMethod: paymentMethod || 'bank_transfer',
            paymentDate: paymentDate || timestamp(),
            invoiceNumber: invoiceNumber || null,
            notes: notes || '',
            status: 'completed',
            
            // User tracking
            createdBy: req.user.name,
            createdByUid: req.user.uid,
            createdAt: timestamp(),
            updatedAt: timestamp()
        };

        await putItem(process.env.PAYMENTS_TABLE || 'PMTrackerPayments', paymentData);

        return res.status(201).json({
            success: true,
            data: paymentData
        });

    } catch (error) {
        console.error('Error in POST /payments:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// PUT /api/payments/:id - Update payment
// ============================================
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        // Only accounts, COO, and director can update payments
        const allowedRoles = ['coo', 'director', 'accounts'];
        
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        const payment = await getItem(process.env.PAYMENTS_TABLE || 'PMTrackerPayments', { id });
        
        if (!payment) {
            return res.status(404).json({
                success: false,
                error: 'Payment not found'
            });
        }

        updates.updatedAt = timestamp();
        updates.updatedBy = req.user.name;
        
        const updated = await updateItem(process.env.PAYMENTS_TABLE || 'PMTrackerPayments', { id }, updates);

        return res.status(200).json({
            success: true,
            data: updated
        });

    } catch (error) {
        console.error('Error in PUT /payments/:id:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;


















