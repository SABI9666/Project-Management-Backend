// src/api/proposals.js - Proposals API (Self-Contained Fix)
const express = require('express');
const crypto = require('crypto'); // Native Node.js module for robust ID generation
const { verifyToken } = require('../middleware/auth.js');
const { 
    getItem, 
    putItem, 
    updateItem, 
    deleteItem, 
    scanTable
} = require('../utils/dynamodb');

const router = express.Router();

// Apply authentication middleware
router.use(verifyToken);

// Helper for robust timestamp (Numbers for DynamoDB)
const getTimestamp = () => Date.now();

// ============================================
// GET /api/proposals - List proposals
// ============================================
router.get('/', async (req, res) => {
    try {
        const { status, id } = req.query;

        // Get single proposal
        if (id) {
            // Try fetching by proposalId (likely PK)
            let proposal = await getItem(process.env.PROPOSALS_TABLE, { proposalId: id });
            
            // Fallback: Try fetching by id if first attempt failed
            if (!proposal) {
                proposal = await getItem(process.env.PROPOSALS_TABLE, { id: id });
            }
            
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
                req.user.role === 'bdm' ||
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

        if (req.user.role === 'coo' || req.user.role === 'director' || req.user.role === 'estimator') {
            // Admin users can see all proposals
            proposals = await scanTable(process.env.PROPOSALS_TABLE);
        } else if (req.user.role === 'bdm') {
            // BDM can only see their own proposals
            const allProposals = await scanTable(process.env.PROPOSALS_TABLE);
            proposals = allProposals.filter(p => p.submittedByUid === req.user.uid);
        } else {
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
// POST /api/proposals - Create new proposal (FIXED)
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

        // Validate required fields
        if (!projectName || !clientCompany) {
            return res.status(400).json({
                success: false,
                error: 'Project name and client company are required'
            });
        }

        // Generate robust ID and Timestamp locally
        const newId = crypto.randomUUID(); 
        const now = getTimestamp();
        
        const proposalData = {
            // CRITICAL FIX: Include BOTH naming conventions to satisfy DynamoDB Schema
            // regardless of whether Partition Key is 'id' or 'proposalId'
            proposalId: newId, 
            id: newId, 
            
            // CRITICAL FIX: Include createdAt in case it's a Sort Key
            createdAt: now,
            updatedAt: now,

            projectName,
            clientCompany,
            clientContact: clientContact || '',
            clientEmail: clientEmail || '',
            clientPhone: clientPhone || '',
            projectDescription: projectDescription || '',
            estimatedValue: estimatedValue ? parseFloat(estimatedValue) : 0,
            currency: currency || 'USD',
            proposedTimeline: proposedTimeline || '',
            deliverables: deliverables || [],
            scopeOfWork: scopeOfWork || '',
            specialRequirements: specialRequirements || '',
            
            // Status tracking
            status: 'pending',
            
            // User tracking
            submittedBy: req.user.name || 'Unknown User',
            submittedByUid: req.user.uid,
            submittedByEmail: req.user.email,
            submittedAt: now,
            
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
            quoteCurrency: null
        };

        console.log('Attempting to create proposal with keys:', { 
            proposalId: proposalData.proposalId, 
            id: proposalData.id,
            createdAt: proposalData.createdAt 
        });

        await putItem(process.env.PROPOSALS_TABLE, proposalData);

        return res.status(201).json({
            success: true,
            data: proposalData
        });

    } catch (error) {
        console.error('Error in POST /proposals:', error);
        return res.status(500).json({
            success: false,
            error: `DB Error: ${error.message}`
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

        // Check if proposal exists (try both keys)
        let proposal = await getItem(process.env.PROPOSALS_TABLE, { proposalId: id });
        let keyObj = { proposalId: id };

        if (!proposal) {
            proposal = await getItem(process.env.PROPOSALS_TABLE, { id: id });
            keyObj = { id: id };
        }
        
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
        updates.updatedAt = getTimestamp();
        
        // Remove sensitive keys from updates if they exist
        delete updates.id;
        delete updates.proposalId;
        delete updates.createdAt;

        const updated = await updateItem(process.env.PROPOSALS_TABLE, keyObj, updates);

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
        let proposal = await getItem(process.env.PROPOSALS_TABLE, { proposalId: id });
        let keyObj = { proposalId: id };

        if (!proposal) {
            proposal = await getItem(process.env.PROPOSALS_TABLE, { id: id });
            keyObj = { id: id };
        }
        
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

        await deleteItem(process.env.PROPOSALS_TABLE, keyObj);

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
