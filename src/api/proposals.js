// src/api/proposals.js - Proposals API with AWS DynamoDB (FIXED - No Index Required)
const express = require('express');
const { verifyToken } = require('../middleware/auth.js');
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

const router = express.Router();

// Apply authentication middleware
router.use(verifyToken);

// ============================================
// GET /api/proposals - List proposals (FIXED)
// ============================================
router.get('/', async (req, res) => {
    try {
        const { status, id } = req.query;

        // Get single proposal
        if (id) {
            const proposal = await getItem(process.env.PROPOSALS_TABLE, { id: id });
            
            if (!proposal) {
                return res.status(404).json({
                    success: false,
                    error: 'Proposal not found'
                });
            }

            // Check permissions
            const canView = 
                req.user.role === 'coo' ||
                req.user.role === 'director' ||
                req.user.role === 'estimator' ||
                req.user.role === 'bdm' || // Added BDM
                proposal.submittedByUid === req.user.uid;

            if (!canView) {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied'
                });
            }

            return res.status(200).json({
                success: true,
                data: proposal
            });
        }

        // List all proposals
        let proposals = [];

        // ============================================
        // FIXED: Use scanTable instead of queryByIndex
        // This works even without DynamoDB GSI
        // ============================================
        if (req.user.role === 'coo' || req.user.role === 'director' || req.user.role === 'estimator') {
            // Admin users can see all proposals
            proposals = await scanTable(process.env.PROPOSALS_TABLE);
        } else if (req.user.role === 'bdm') {
            // BDM can only see their own proposals
            // FIXED: Scan and filter instead of using index
            const allProposals = await scanTable(process.env.PROPOSALS_TABLE);
            proposals = allProposals.filter(p => p.submittedByUid === req.user.uid);
        } else {
            // Other roles get empty list
            proposals = [];
        }

        // Filter by status if provided
        if (status) {
            proposals = proposals.filter(p => p.status === status);
        }

        // Sort by submission date (newest first)
        proposals.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

        return res.status(200).json({
            success: true,
            data: proposals
        });

    } catch (error) {
        console.error('Error in GET /proposals:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// POST /api/proposals - Create new proposal
// ============================================
router.post('/', async (req, res) => {
    try {
        // Only BDM can create proposals
        if (req.user.role !== 'bdm') {
            return res.status(403).json({
                success: false,
                error: 'Only BDM can create proposals'
            });
        }

        const {
            projectName,
            clientCompany,
            clientContact,
            clientEmail,
            clientPhone,
            projectDescription,
            estimatedValue,
            currency,
            proposedTimeline,
            deliverables,
            scopeOfWork,
            specialRequirements
        } = req.body;

        // Validate required fields (estimatedValue is now optional)
        if (!projectName || !clientCompany) {
            return res.status(400).json({
                success: false,
                error: 'Project name and client company are required'
            });
        }

        const proposalId = generateId();
        const proposalData = {
            id: proposalId, // DynamoDB partition key
            projectName,
            clientCompany,
            clientContact: clientContact || '',
            clientEmail: clientEmail || '',
            clientPhone: clientPhone || '',
            projectDescription: projectDescription || '',
            estimatedValue: estimatedValue ? parseFloat(estimatedValue) : 0, // Default to 0 if not provided
            currency: currency || 'USD',
            proposedTimeline: proposedTimeline || '',
            deliverables: deliverables || [],
            scopeOfWork: scopeOfWork || '',
            specialRequirements: specialRequirements || '',
            
            // Status tracking
            status: 'pending',
            
            // User tracking
            submittedBy: req.user.name,
            submittedByUid: req.user.uid,
            submittedByEmail: req.user.email,
            submittedAt: timestamp(),
            
            // Approval tracking
            reviewedBy: null,
            reviewedByUid: null,
            reviewedAt: null,
            reviewNotes: null,
            
            // Pricing tracking
            pricingStatus: 'pending',
            assignedEstimatorUid: null,
            assignedEstimatorName: null,
            quoteValue: null,
            quoteCurrency: null,
            
            // Timestamps
            createdAt: timestamp(),
            updatedAt: timestamp()
        };

        await putItem(process.env.PROPOSALS_TABLE, proposalData);

        return res.status(201).json({
            success: true,
            data: proposalData
        });

    } catch (error) {
        console.error('Error in POST /proposals:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// PUT /api/proposals/:id - Update proposal
// ============================================
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        // Get existing proposal
        const proposal = await getItem(process.env.PROPOSALS_TABLE, { id: id });
        
        if (!proposal) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        // Check permissions
        const canUpdate = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            (req.user.role === 'bdm' && proposal.submittedByUid === req.user.uid);

        if (!canUpdate) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        // Update the proposal
        updates.updatedAt = timestamp();
        const updated = await updateItem(process.env.PROPOSALS_TABLE, { id: id }, updates);

        return res.status(200).json({
            success: true,
            data: updated
        });

    } catch (error) {
        console.error('Error in PUT /proposals/:id:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// DELETE /api/proposals/:id - Delete proposal
// ============================================
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Get existing proposal
        const proposal = await getItem(process.env.PROPOSALS_TABLE, { id: id });
        
        if (!proposal) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        // Only creator or admin can delete
        const canDelete = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            (req.user.role === 'bdm' && proposal.submittedByUid === req.user.uid);

        if (!canDelete) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        await deleteItem(process.env.PROPOSALS_TABLE, { id: id });

        return res.status(200).json({
            success: true,
            message: 'Proposal deleted successfully'
        });

    } catch (error) {
        console.error('Error in DELETE /proposals/:id:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;


















