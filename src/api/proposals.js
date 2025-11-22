// src/api/proposals.js - Proposals API (Fixing DynamoDB Key Typo 'proposald')
const express = require('express');
const AWS = require('aws-sdk'); 
const crypto = require('crypto');
const { verifyToken } = require('../middleware/auth.js');
const { scanTable } = require('../utils/dynamodb');

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
            // FIXED: Trying 'proposald' (based on screenshot typo) and 'proposalId'
            const params = {
                TableName: process.env.PROPOSALS_TABLE,
                Key: { proposald: id } // Try the typo key first
            };

            let result = await docClient.get(params).promise();
            
            // Fallback: Try standard keys if first attempt failed
            if (!result.Item) {
                params.Key = { proposalId: id };
                result = await docClient.get(params).promise();
            }
            if (!result.Item) {
                params.Key = { id: id };
                result = await docClient.get(params).promise();
            }
            
            if (!result.Item) {
                return res.status(404).json({
                    success: false,
                    error: 'Proposal not found'
                });
            }

            const proposal = result.Item;

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
// POST /api/proposals - Create new proposal
// ============================================
router.post('/', async (req, res) => {
    try {
        if (req.user.role !== 'bdm') {
            return res.status(403).json({ success: false, error: 'Only BDM can create proposals' });
        }

        const {
            projectName, clientCompany, clientContact, clientEmail, clientPhone,
            projectDescription, estimatedValue, currency, proposedTimeline,
            deliverables, scopeOfWork, specialRequirements
        } = req.body;

        if (!projectName || !clientCompany) {
            return res.status(400).json({ success: false, error: 'Project name and client company are required' });
        }

        const newId = crypto.randomUUID();
        const now = getTimestamp();
        
        const proposalData = {
            // --- CRITICAL FIX: Handle DynamoDB Key Typo ---
            proposald: newId,  // Matches 'proposald' in your Screenshot
            proposalId: newId, // Standard convention
            id: newId,         // Legacy convention
            
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
            status: 'pending',
            submittedBy: req.user.name || 'Unknown',
            submittedByUid: req.user.uid,
            submittedByEmail: req.user.email,
            submittedAt: now,
            pricingStatus: 'pending'
        };

        const params = {
            TableName: process.env.PROPOSALS_TABLE,
            Item: proposalData
        };

        console.log(`Attempting PUT to ${params.TableName} with keys: proposald=${newId}`);

        await docClient.put(params).promise();

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

        // 1. FIND the item first to determine the correct key
        let keyObj = null;
        
        // Try finding with 'proposald'
        let check = await docClient.get({ TableName: process.env.PROPOSALS_TABLE, Key: { proposald: id } }).promise();
        if (check.Item) {
            keyObj = { proposald: id };
        } else {
            // Try 'proposalId'
            check = await docClient.get({ TableName: process.env.PROPOSALS_TABLE, Key: { proposalId: id } }).promise();
            if (check.Item) {
                keyObj = { proposalId: id };
            } else {
                // Try 'id'
                check = await docClient.get({ TableName: process.env.PROPOSALS_TABLE, Key: { id: id } }).promise();
                if (check.Item) keyObj = { id: id };
            }
        }

        if (!keyObj || !check.Item) {
            return res.status(404).json({ success: false, error: 'Proposal not found' });
        }

        const proposal = check.Item;

        // Check permissions
        const canUpdate = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            (req.user.role === 'bdm' && proposal.submittedByUid === req.user.uid);

        if (!canUpdate) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        // Prepare Update
        updates.updatedAt = getTimestamp();
        
        // Remove keys from update object to prevent immutable key error
        delete updates.id;
        delete updates.proposalId;
        delete updates.proposald;
        delete updates.createdAt;

        // Build Update Expression
        let updateExpression = 'set';
        const expressionAttributeNames = {};
        const expressionAttributeValues = {};

        Object.keys(updates).forEach((key, index) => {
            const attrName = `#attr${index}`;
            const attrValue = `:val${index}`;
            updateExpression += ` ${attrName} = ${attrValue},`;
            expressionAttributeNames[attrName] = key;
            expressionAttributeValues[attrValue] = updates[key];
        });

        // Remove trailing comma
        updateExpression = updateExpression.slice(0, -1);

        const updateParams = {
            TableName: process.env.PROPOSALS_TABLE,
            Key: keyObj,
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        };

        const updatedResult = await docClient.update(updateParams).promise();

        return res.status(200).json({
            success: true,
            data: updatedResult.Attributes
        });

    } catch (error) {
        console.error('Error in PUT /proposals/:id:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// DELETE /api/proposals/:id - Delete proposal
// ============================================
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Identify correct key
        let keyObj = null;
        
        // Check 'proposald'
        let check = await docClient.get({ TableName: process.env.PROPOSALS_TABLE, Key: { proposald: id } }).promise();
        if (check.Item) keyObj = { proposald: id };
        else {
            // Check 'proposalId'
            check = await docClient.get({ TableName: process.env.PROPOSALS_TABLE, Key: { proposalId: id } }).promise();
            if (check.Item) keyObj = { proposalId: id };
            else {
                // Check 'id'
                check = await docClient.get({ TableName: process.env.PROPOSALS_TABLE, Key: { id: id } }).promise();
                if (check.Item) keyObj = { id: id };
            }
        }

        if (!keyObj || !check.Item) {
            return res.status(404).json({ success: false, error: 'Proposal not found' });
        }

        const proposal = check.Item;
        const canDelete = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            (req.user.role === 'bdm' && proposal.submittedByUid === req.user.uid);

        if (!canDelete) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        await docClient.delete({
            TableName: process.env.PROPOSALS_TABLE,
            Key: keyObj
        }).promise();

        return res.status(200).json({
            success: true,
            message: 'Proposal deleted successfully'
        });

    } catch (error) {
        console.error('Error in DELETE /proposals/:id:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
