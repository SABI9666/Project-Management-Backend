// src/api/proposals.js - Proposals API (Direct SDK Usage Fix)
const express = require('express');
const AWS = require('aws-sdk'); // Use direct SDK to bypass utility issues
const crypto = require('crypto');
const { verifyToken } = require('../middleware/auth.js');
// Keep utility imports for other routes to avoid breaking them
const { 
    getItem, 
    updateItem, 
    deleteItem, 
    scanTable
} = require('../utils/dynamodb');

const router = express.Router();

// Initialize standard DocumentClient
const docClient = new AWS.DynamoDB.DocumentClient();

// Apply authentication middleware
router.use(verifyToken);

// Helper for timestamps
const getTimestamp = () => Date.now();

// ============================================
// GET /api/proposals - List proposals
// ============================================
router.get('/', async (req, res) => {
    try {
        const { status, id } = req.query;

        // Get single proposal
        if (id) {
            // Try searching with proposalId first (likely PK)
            let proposal = await getItem(process.env.PROPOSALS_TABLE, { proposalId: id });
            
            // Fallback: Try id if proposalId didn't work
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
            proposals = await scanTable(process.env.PROPOSALS_TABLE);
        } else if (req.user.role === 'bdm') {
            const allProposals = await scanTable(process.env.PROPOSALS_TABLE);
            proposals = allProposals.filter(p => p.submittedByUid === req.user.uid);
        } else {
            proposals = [];
        }

        if (status) {
            proposals = proposals.filter(p => p.status === status);
        }

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
// POST /api/proposals - Create new proposal (DIRECT SDK FIX)
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

        if (!projectName || !clientCompany) {
            return res.status(400).json({
                success: false,
                error: 'Project name and client company are required'
            });
        }

        // Generate ID and Timestamp
        const newId = crypto.randomUUID();
        const now = getTimestamp();
        
        const proposalData = {
            // --- CRITICAL: Include Keys for ALL Schema Possibilities ---
            proposalId: newId, // Likely Partition Key
            id: newId,         // Fallback Partition Key
            createdAt: now,    // Potential Sort Key
            
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
            submittedBy: req.user.name || 'Unknown',
            submittedByUid: req.user.uid,
            submittedByEmail: req.user.email,
            submittedAt: now,
            
            // Initialize empty fields
            reviewedBy: null,
            reviewedByUid: null,
            reviewedAt: null,
            pricingStatus: 'pending',
            assignedEstimatorUid: null,
            quoteValue: null
        };

        console.log('Creating Proposal with Table:', process.env.PROPOSALS_TABLE);
        console.log('Item Keys:', { proposalId: newId, id: newId });

        // --- DIRECT SDK CALL (Bypasses utils/dynamodb.js) ---
        const params = {
            TableName: process.env.PROPOSALS_TABLE,
            Item: proposalData
        };

        await docClient.put(params).promise();

        return res.status(201).json({
            success: true,
            data: proposalData
        });

    } catch (error) {
        console.error('Error in POST /proposals:', error);
        // Return exact DB error for debugging
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

        // Try finding item with both key possibilities
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

        // Permission check
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

        updates.updatedAt = getTimestamp();
        
        // Protect keys from being overwritten
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

        // Identify correct key
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
