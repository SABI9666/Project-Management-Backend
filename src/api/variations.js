// src/api/variations.js - Project Variations API with AWS DynamoDB
const express = require('express');
const { verifyToken } = require('../middleware/auth');
const { 
    getItem, putItem, updateItem, deleteItem,
    queryByIndex, scanTable, generateId, timestamp, incrementField
} = require('../utils/dynamodb');
const { sendNotificationEmail } = require('../utils/email');

const router = express.Router();
router.use(verifyToken);

// POST /api/variations - Submit variation
router.post('/', async (req, res) => {
    try {
        const { projectId, scopeDescription, estimatedHours, justification } = req.body;

        if (!projectId || !scopeDescription || !estimatedHours) {
            return res.status(400).json({ success: false, error: 'Project ID, description, and hours required' });
        }

        const project = await getItem(process.env.PROJECTS_TABLE, { id: projectId });
        if (!project) {
            return res.status(404).json({ success: false, error: 'Project not found' });
        }

        const canSubmit = 
            req.user.role === 'coo' ||
            project.designLeadUid === req.user.uid;

        if (!canSubmit) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const variationId = generateId();
        const variationCode = `VAR-${project.projectCode}-${Date.now().toString().slice(-6)}`;

        const variationData = {
            id: variationId,
            variationCode,
            projectId, projectName: project.projectName,
            projectCode: project.projectCode,
            scopeDescription,
            estimatedHours: parseFloat(estimatedHours),
            justification: justification || '',
            status: 'pending', // pending, approved, rejected
            submittedBy: req.user.name,
            submittedByUid: req.user.uid,
            submittedAt: timestamp(),
            reviewedBy: null, reviewedAt: null,
            approvedHours: null, reviewNotes: null,
            createdAt: timestamp(), updatedAt: timestamp()
        };

        await putItem(process.env.VARIATIONS_TABLE, variationData);

        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(), type: 'variation_submitted',
            details: `Variation ${variationCode} submitted for ${project.projectName}`,
            performedByName: req.user.name, performedByUid: req.user.uid,
            timestamp: timestamp(), projectId
        });

        // Notify COO
        const cooUsers = await queryByIndex(process.env.USERS_TABLE, 'role-index', {
            expression: '#role = :role', names: { '#role': 'role' }, values: { ':role': 'coo' }
        });

        if (cooUsers && cooUsers.length > 0) {
            await sendNotificationEmail(
                cooUsers.map(u => u.email),
                'variationSubmitted',
                {
                    variationCode, projectName: project.projectName,
                    estimatedHours, submittedBy: req.user.name,
                    scopeDescription, loginUrl: process.env.FRONTEND_URL
                }
            );
        }

        return res.status(201).json({ success: true, data: variationData });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/variations - List variations
router.get('/', async (req, res) => {
    try {
        const { projectId, status, id } = req.query;

        if (id) {
            const variation = await getItem(process.env.VARIATIONS_TABLE, { id });
            return variation 
                ? res.status(200).json({ success: true, data: variation })
                : res.status(404).json({ success: false, error: 'Not found' });
        }

        let variations = [];

        if (projectId) {
            variations = await queryByIndex(process.env.VARIATIONS_TABLE, 'projectId-index', {
                expression: 'projectId = :projectId', values: { ':projectId': projectId }
            });
        } else if (['coo', 'director'].includes(req.user.role)) {
            variations = await scanTable(process.env.VARIATIONS_TABLE);
        } else {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        if (status) variations = variations.filter(v => v.status === status);
        variations.sort((a, b) => b.submittedAt - a.submittedAt);

        return res.status(200).json({ success: true, data: variations });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/variations/:id/approve - Approve variation
router.put('/:id/approve', async (req, res) => {
    try {
        if (req.user.role !== 'coo') {
            return res.status(403).json({ success: false, error: 'Only COO can approve variations' });
        }

        const { id } = req.params;
        const { approvedHours, notes } = req.body;

        if (!approvedHours) {
            return res.status(400).json({ success: false, error: 'Approved hours required' });
        }

        const variation = await getItem(process.env.VARIATIONS_TABLE, { id });
        if (!variation) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        if (variation.status !== 'pending') {
            return res.status(400).json({ success: false, error: 'Already processed' });
        }

        await updateItem(process.env.VARIATIONS_TABLE, { id }, {
            status: 'approved',
            approvedHours: parseFloat(approvedHours),
            reviewedBy: req.user.name,
            reviewedAt: timestamp(),
            reviewNotes: notes || null,
            updatedAt: timestamp()
        });

        // Add hours to project
        await incrementField(process.env.PROJECTS_TABLE, { id: variation.projectId }, 'allocatedHours', parseFloat(approvedHours));

        const project = await getItem(process.env.PROJECTS_TABLE, { id: variation.projectId });
        if (project) {
            const newTotal = (project.allocatedHours || 0) + parseFloat(approvedHours);
            const remaining = newTotal - (project.usedHours || 0);
            await updateItem(process.env.PROJECTS_TABLE, { id: variation.projectId }, {
                remainingHours: remaining, updatedAt: timestamp()
            });
        }

        await sendNotificationEmail(
            [variation.submittedByEmail],
            'variationApproved',
            {
                variationCode: variation.variationCode,
                projectName: variation.projectName,
                approvedHours, approvedBy: req.user.name,
                notes, loginUrl: process.env.FRONTEND_URL
            }
        );

        return res.status(200).json({ success: true, message: 'Variation approved' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// PUT /api/variations/:id/reject - Reject variation
router.put('/:id/reject', async (req, res) => {
    try {
        if (req.user.role !== 'coo') {
            return res.status(403).json({ success: false, error: 'Only COO can reject variations' });
        }

        const { id } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({ success: false, error: 'Reason required' });
        }

        const variation = await getItem(process.env.VARIATIONS_TABLE, { id });
        if (!variation) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        await updateItem(process.env.VARIATIONS_TABLE, { id }, {
            status: 'rejected',
            reviewedBy: req.user.name,
            reviewedAt: timestamp(),
            reviewNotes: reason,
            updatedAt: timestamp()
        });

        await sendNotificationEmail(
            [variation.submittedByEmail],
            'variationRejected',
            {
                variationCode: variation.variationCode,
                projectName: variation.projectName,
                rejectedBy: req.user.name,
                reason, loginUrl: process.env.FRONTEND_URL
            }
        );

        return res.status(200).json({ success: true, message: 'Variation rejected' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/variations/:id - Delete variation
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const variation = await getItem(process.env.VARIATIONS_TABLE, { id });

        if (!variation) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        const canDelete = req.user.role === 'coo' || variation.submittedByUid === req.user.uid;
        if (!canDelete) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        if (variation.status === 'approved') {
            return res.status(400).json({ success: false, error: 'Cannot delete approved variations' });
        }

        await deleteItem(process.env.VARIATIONS_TABLE, { id });

        return res.status(200).json({ success: true, message: 'Variation deleted' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
