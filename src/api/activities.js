// src/api/activities.js - Activities Log API with AWS DynamoDB
const express = require('express');
const { verifyToken } = require('../middleware/auth');
const { 
    getItem, 
    putItem,
    queryByIndex, 
    scanTable,
    generateId,
    timestamp 
} = require('../utils/dynamodb');

const router = express.Router();
router.use(verifyToken);

// ============================================
// GET /api/activities - List activities
// ============================================
router.get('/', async (req, res) => {
    try {
        const { projectId, userId, type, startDate, endDate, limit = 100 } = req.query;

        let activities = [];

        // Query by project
        if (projectId) {
            activities = await queryByIndex(
                process.env.ACTIVITIES_TABLE,
                'projectId-index',
                {
                    expression: 'projectId = :projectId',
                    values: { ':projectId': projectId }
                }
            );

            // Verify user has access to this project
            const project = await getItem(process.env.PROJECTS_TABLE, { id: projectId });
            if (project) {
                const hasAccess = 
                    req.user.role === 'coo' ||
                    req.user.role === 'director' ||
                    project.designLeadUid === req.user.uid ||
                    (project.assignedDesignerUids || []).includes(req.user.uid);

                if (!hasAccess) {
                    return res.status(403).json({
                        success: false,
                        error: 'Access denied to this project'
                    });
                }
            }
        }
        // Query by user
        else if (userId) {
            // Only admins or the user themselves can see user activities
            if (userId !== req.user.uid && !['coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied'
                });
            }

            activities = await queryByIndex(
                process.env.ACTIVITIES_TABLE,
                'performedByUid-index',
                {
                    expression: 'performedByUid = :uid',
                    values: { ':uid': userId }
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
            activities = await scanTable(process.env.ACTIVITIES_TABLE);
        }

        // Apply filters
        if (type) {
            activities = activities.filter(a => a.type === type);
        }

        if (startDate) {
            const start = typeof startDate === 'number' ? startDate : parseInt(startDate);
            activities = activities.filter(a => a.timestamp >= start);
        }

        if (endDate) {
            const end = typeof endDate === 'number' ? endDate : parseInt(endDate);
            activities = activities.filter(a => a.timestamp <= end);
        }

        // Sort by timestamp (newest first)
        activities.sort((a, b) => b.timestamp - a.timestamp);

        // Limit results
        if (limit) {
            activities = activities.slice(0, parseInt(limit));
        }

        return res.status(200).json({
            success: true,
            data: activities,
            count: activities.length
        });

    } catch (error) {
        console.error('List activities error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch activities',
            message: error.message
        });
    }
});

// ============================================
// GET /api/activities/recent - Get recent activities
// ============================================
router.get('/recent', async (req, res) => {
    try {
        const { limit = 20 } = req.query;

        // Get all activities (for admins) or user's own activities
        let activities = [];

        if (['coo', 'director'].includes(req.user.role)) {
            activities = await scanTable(process.env.ACTIVITIES_TABLE);
        } else {
            activities = await queryByIndex(
                process.env.ACTIVITIES_TABLE,
                'performedByUid-index',
                {
                    expression: 'performedByUid = :uid',
                    values: { ':uid': req.user.uid }
                }
            );
        }

        // Sort by timestamp (newest first)
        activities.sort((a, b) => b.timestamp - a.timestamp);

        // Limit results
        activities = activities.slice(0, parseInt(limit));

        return res.status(200).json({
            success: true,
            data: activities
        });

    } catch (error) {
        console.error('Recent activities error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch recent activities',
            message: error.message
        });
    }
});

// ============================================
// GET /api/activities/project/:projectId - Get project activities
// ============================================
router.get('/project/:projectId', async (req, res) => {
    try {
        const { projectId } = req.params;
        const { limit = 50 } = req.query;

        // Verify user has access to project
        const project = await getItem(process.env.PROJECTS_TABLE, { id: projectId });
        
        if (!project) {
            return res.status(404).json({
                success: false,
                error: 'Project not found'
            });
        }

        const hasAccess = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            project.designLeadUid === req.user.uid ||
            (project.assignedDesignerUids || []).includes(req.user.uid);

        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'Access denied to this project'
            });
        }

        let activities = await queryByIndex(
            process.env.ACTIVITIES_TABLE,
            'projectId-index',
            {
                expression: 'projectId = :projectId',
                values: { ':projectId': projectId }
            }
        );

        // Sort by timestamp (newest first)
        activities.sort((a, b) => b.timestamp - a.timestamp);

        // Limit results
        if (limit) {
            activities = activities.slice(0, parseInt(limit));
        }

        return res.status(200).json({
            success: true,
            data: activities,
            count: activities.length
        });

    } catch (error) {
        console.error('Project activities error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch project activities',
            message: error.message
        });
    }
});

// ============================================
// GET /api/activities/user/:userId - Get user activities
// ============================================
router.get('/user/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 50 } = req.query;

        // Only admins or the user themselves can see activities
        if (userId !== req.user.uid && !['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        let activities = await queryByIndex(
            process.env.ACTIVITIES_TABLE,
            'performedByUid-index',
            {
                expression: 'performedByUid = :uid',
                values: { ':uid': userId }
            }
        );

        // Sort by timestamp (newest first)
        activities.sort((a, b) => b.timestamp - a.timestamp);

        // Limit results
        if (limit) {
            activities = activities.slice(0, parseInt(limit));
        }

        return res.status(200).json({
            success: true,
            data: activities,
            count: activities.length
        });

    } catch (error) {
        console.error('User activities error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch user activities',
            message: error.message
        });
    }
});

// ============================================
// GET /api/activities/types - Get activity types
// ============================================
router.get('/types', async (req, res) => {
    try {
        // Return available activity types
        const activityTypes = [
            'proposal_submitted',
            'proposal_approved',
            'proposal_rejected',
            'pricing_completed',
            'project_created',
            'design_lead_allocated',
            'designers_assigned',
            'project_status_updated',
            'project_updated',
            'project_deleted',
            'file_uploaded',
            'file_downloaded',
            'file_deleted',
            'timesheet_submitted',
            'timesheet_approved',
            'timesheet_rejected',
            'time_request_submitted',
            'time_request_approved',
            'time_request_rejected',
            'variation_submitted',
            'variation_approved',
            'variation_rejected',
            'payment_received',
            'payment_overdue',
            'deliverable_submitted',
            'deliverable_approved',
            'user_created',
            'user_updated',
            'user_deleted'
        ];

        return res.status(200).json({
            success: true,
            data: activityTypes
        });

    } catch (error) {
        console.error('Activity types error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch activity types',
            message: error.message
        });
    }
});

// ============================================
// POST /api/activities - Log activity (internal use)
// ============================================
router.post('/', async (req, res) => {
    try {
        // Only system or admins can log activities manually
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions'
            });
        }

        const {
            type,
            details,
            projectId,
            userId
        } = req.body;

        if (!type || !details) {
            return res.status(400).json({
                success: false,
                error: 'Type and details are required'
            });
        }

        const activityId = generateId();
        const activityData = {
            id: activityId,
            type,
            details,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: projectId || null,
            userId: userId || null
        };

        await putItem(process.env.ACTIVITIES_TABLE, activityData);

        return res.status(201).json({
            success: true,
            message: 'Activity logged',
            data: activityData
        });

    } catch (error) {
        console.error('Log activity error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to log activity',
            message: error.message
        });
    }
});

module.exports = router;
