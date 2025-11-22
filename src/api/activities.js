// src/api/activities.js - Activities API (FIXED for BDM access)
const express = require('express');
const { verifyToken } = require('../middleware/auth.js');
const { scanTable, putItem, generateId, timestamp } = require('../utils/dynamodb');

const router = express.Router();
router.use(verifyToken);

// ============================================
// GET /api/activities - Get activities (FIXED)
// ============================================
router.get('/', async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        
        // ============================================
        // FIXED: Allow BDM to see all activities
        // ============================================
        const allowedRoles = ['coo', 'director', 'bdm', 'estimator'];
        
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions'
            });
        }

        // Get all activities
        let activities = await scanTable(process.env.ACTIVITIES_TABLE);
        
        // Filter by user if not admin
        if (req.user.role === 'bdm') {
            // BDM sees all activities related to proposals/projects
            // For now, show all - can be filtered later
            // activities = activities.filter(a => a.performedByUid === req.user.uid);
        }
        
        // Sort by timestamp (newest first)
        activities.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        
        // Limit results
        activities = activities.slice(0, parseInt(limit));

        return res.status(200).json({
            success: true,
            data: activities
        });

    } catch (error) {
        console.error('Error in GET /activities:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// POST /api/activities - Log activity
// ============================================
router.post('/', async (req, res) => {
    try {
        const {
            action,
            description,
            entityType,
            entityId,
            metadata
        } = req.body;

        if (!action || !description) {
            return res.status(400).json({
                success: false,
                error: 'Action and description are required'
            });
        }

        const activityId = generateId();
        const activityData = {
            id: activityId,
            action,
            description,
            entityType: entityType || 'general',
            entityId: entityId || null,
            metadata: metadata || {},
            
            // User info
            performedBy: req.user.name,
            performedByUid: req.user.uid,
            performedByEmail: req.user.email,
            performedByRole: req.user.role,
            
            // Timestamp
            timestamp: timestamp(),
            createdAt: timestamp()
        };

        await putItem(process.env.ACTIVITIES_TABLE, activityData);

        return res.status(201).json({
            success: true,
            data: activityData
        });

    } catch (error) {
        console.error('Error in POST /activities:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;


















