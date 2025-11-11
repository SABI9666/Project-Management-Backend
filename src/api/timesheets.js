// src/api/timesheets.js - Timesheets API with AWS DynamoDB
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
    timestamp,
    incrementField
} = require('../utils/dynamodb');
const { sendNotificationEmail } = require('../utils/email');

const router = express.Router();
router.use(verifyToken);

// ============================================
// POST /api/timesheets - Submit timesheet
// ============================================
router.post('/', async (req, res) => {
    try {
        const {
            projectId,
            date,
            hours,
            description,
            taskType
        } = req.body;

        // Validate
        if (!projectId || !date || !hours) {
            return res.status(400).json({
                success: false,
                error: 'Project ID, date, and hours are required'
            });
        }

        if (hours <= 0 || hours > 24) {
            return res.status(400).json({
                success: false,
                error: 'Hours must be between 0 and 24'
            });
        }

        // Verify project exists and user has access
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
                error: 'You are not assigned to this project'
            });
        }

        const timesheetId = generateId();
        const timesheetData = {
            id: timesheetId,
            projectId,
            projectName: project.projectName,
            projectCode: project.projectCode,
            
            userId: req.user.uid,
            userName: req.user.name,
            userRole: req.user.role,
            
            date: typeof date === 'number' ? date : timestamp(),
            hours: parseFloat(hours),
            description: description || '',
            taskType: taskType || 'general',
            
            status: 'pending', // pending, approved, rejected
            approvedBy: null,
            approvedAt: null,
            rejectionReason: null,
            
            createdAt: timestamp(),
            updatedAt: timestamp()
        };

        await putItem(process.env.TIMESHEETS_TABLE, timesheetData);

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'timesheet_submitted',
            details: `${req.user.name} submitted ${hours} hours for ${project.projectName}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId,
            timesheetId
        });

        return res.status(201).json({
            success: true,
            message: 'Timesheet submitted successfully',
            data: timesheetData
        });

    } catch (error) {
        console.error('Submit timesheet error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to submit timesheet',
            message: error.message
        });
    }
});

// ============================================
// GET /api/timesheets - List timesheets
// ============================================
router.get('/', async (req, res) => {
    try {
        const { projectId, userId, status, startDate, endDate, id } = req.query;

        // Get single timesheet
        if (id) {
            const timesheet = await getItem(process.env.TIMESHEETS_TABLE, { id });
            
            if (!timesheet) {
                return res.status(404).json({
                    success: false,
                    error: 'Timesheet not found'
                });
            }

            // Check permissions
            const canView = 
                req.user.role === 'coo' ||
                req.user.role === 'director' ||
                timesheet.userId === req.user.uid;

            if (!canView) {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied'
                });
            }

            return res.status(200).json({
                success: true,
                data: timesheet
            });
        }

        let timesheets = [];

        // Query by project
        if (projectId) {
            timesheets = await queryByIndex(
                process.env.TIMESHEETS_TABLE,
                'projectId-index',
                {
                    expression: 'projectId = :projectId',
                    values: { ':projectId': projectId }
                }
            );

            // Verify access
            const project = await getItem(process.env.PROJECTS_TABLE, { id: projectId });
            if (project) {
                const hasAccess = 
                    req.user.role === 'coo' ||
                    req.user.role === 'director' ||
                    project.designLeadUid === req.user.uid;

                if (!hasAccess) {
                    return res.status(403).json({
                        success: false,
                        error: 'Access denied'
                    });
                }
            }
        }
        // Query by user
        else if (userId || req.user.role === 'designer') {
            const targetUserId = userId || req.user.uid;

            // Only admins can see other users' timesheets
            if (userId && userId !== req.user.uid && !['coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied'
                });
            }

            timesheets = await queryByIndex(
                process.env.TIMESHEETS_TABLE,
                'userId-index',
                {
                    expression: 'userId = :userId',
                    values: { ':userId': targetUserId }
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
            timesheets = await scanTable(process.env.TIMESHEETS_TABLE);
        }

        // Apply filters
        if (status) {
            timesheets = timesheets.filter(t => t.status === status);
        }

        if (startDate) {
            const start = typeof startDate === 'number' ? startDate : parseInt(startDate);
            timesheets = timesheets.filter(t => t.date >= start);
        }

        if (endDate) {
            const end = typeof endDate === 'number' ? endDate : parseInt(endDate);
            timesheets = timesheets.filter(t => t.date <= end);
        }

        // Sort by date (newest first)
        timesheets.sort((a, b) => b.date - a.date);

        return res.status(200).json({
            success: true,
            data: timesheets,
            count: timesheets.length
        });

    } catch (error) {
        console.error('List timesheets error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch timesheets',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/timesheets/:id/approve - Approve timesheet
// ============================================
router.put('/:id/approve', async (req, res) => {
    try {
        // Only COO/Director/Design Lead can approve
        if (!['coo', 'director', 'design_manager'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director/Design Lead can approve timesheets'
            });
        }

        const { id } = req.params;
        const timesheet = await getItem(process.env.TIMESHEETS_TABLE, { id });

        if (!timesheet) {
            return res.status(404).json({
                success: false,
                error: 'Timesheet not found'
            });
        }

        if (timesheet.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: 'Timesheet has already been processed'
            });
        }

        // If design lead, verify they lead this project
        if (req.user.role === 'design_manager') {
            const project = await getItem(process.env.PROJECTS_TABLE, { id: timesheet.projectId });
            if (project && project.designLeadUid !== req.user.uid) {
                return res.status(403).json({
                    success: false,
                    error: 'You can only approve timesheets for your projects'
                });
            }
        }

        // Update timesheet
        await updateItem(
            process.env.TIMESHEETS_TABLE,
            { id },
            {
                status: 'approved',
                approvedBy: req.user.name,
                approvedAt: timestamp(),
                updatedAt: timestamp()
            }
        );

        // Increment project used hours
        await incrementField(
            process.env.PROJECTS_TABLE,
            { id: timesheet.projectId },
            'usedHours',
            timesheet.hours
        );

        // Update remaining hours and progress
        const project = await getItem(process.env.PROJECTS_TABLE, { id: timesheet.projectId });
        if (project) {
            const newUsedHours = (project.usedHours || 0) + timesheet.hours;
            const remainingHours = project.allocatedHours - newUsedHours;
            const progressPercentage = Math.min(
                Math.round((newUsedHours / project.allocatedHours) * 100),
                100
            );

            await updateItem(
                process.env.PROJECTS_TABLE,
                { id: timesheet.projectId },
                {
                    remainingHours,
                    progressPercentage,
                    updatedAt: timestamp()
                }
            );
        }

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'timesheet_approved',
            details: `Timesheet for ${timesheet.hours} hours approved by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: timesheet.projectId,
            timesheetId: id
        });

        return res.status(200).json({
            success: true,
            message: 'Timesheet approved successfully'
        });

    } catch (error) {
        console.error('Approve timesheet error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to approve timesheet',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/timesheets/:id/reject - Reject timesheet
// ============================================
router.put('/:id/reject', async (req, res) => {
    try {
        if (!['coo', 'director', 'design_manager'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director/Design Lead can reject timesheets'
            });
        }

        const { id } = req.params;
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({
                success: false,
                error: 'Rejection reason is required'
            });
        }

        const timesheet = await getItem(process.env.TIMESHEETS_TABLE, { id });

        if (!timesheet) {
            return res.status(404).json({
                success: false,
                error: 'Timesheet not found'
            });
        }

        if (timesheet.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: 'Timesheet has already been processed'
            });
        }

        // Update timesheet
        await updateItem(
            process.env.TIMESHEETS_TABLE,
            { id },
            {
                status: 'rejected',
                approvedBy: req.user.name,
                approvedAt: timestamp(),
                rejectionReason: reason,
                updatedAt: timestamp()
            }
        );

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'timesheet_rejected',
            details: `Timesheet rejected by ${req.user.name}: ${reason}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: timesheet.projectId,
            timesheetId: id
        });

        return res.status(200).json({
            success: true,
            message: 'Timesheet rejected'
        });

    } catch (error) {
        console.error('Reject timesheet error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to reject timesheet',
            message: error.message
        });
    }
});

// ============================================
// GET /api/timesheets/summary - Get time summary
// ============================================
router.get('/summary', async (req, res) => {
    try {
        const { userId, projectId, startDate, endDate } = req.query;

        // Get timesheets based on filters
        let timesheets = [];

        if (projectId) {
            timesheets = await queryByIndex(
                process.env.TIMESHEETS_TABLE,
                'projectId-index',
                {
                    expression: 'projectId = :projectId',
                    values: { ':projectId': projectId }
                }
            );
        } else if (userId) {
            timesheets = await queryByIndex(
                process.env.TIMESHEETS_TABLE,
                'userId-index',
                {
                    expression: 'userId = :userId',
                    values: { ':userId': userId }
                }
            );
        } else if (['coo', 'director'].includes(req.user.role)) {
            timesheets = await scanTable(process.env.TIMESHEETS_TABLE);
        } else {
            // Regular users see their own summary
            timesheets = await queryByIndex(
                process.env.TIMESHEETS_TABLE,
                'userId-index',
                {
                    expression: 'userId = :userId',
                    values: { ':userId': req.user.uid }
                }
            );
        }

        // Apply date filters
        if (startDate) {
            timesheets = timesheets.filter(t => t.date >= parseInt(startDate));
        }
        if (endDate) {
            timesheets = timesheets.filter(t => t.date <= parseInt(endDate));
        }

        // Calculate summary
        const summary = {
            totalHours: 0,
            approvedHours: 0,
            pendingHours: 0,
            rejectedHours: 0,
            entriesCount: timesheets.length,
            byProject: {},
            byStatus: {
                pending: 0,
                approved: 0,
                rejected: 0
            }
        };

        timesheets.forEach(t => {
            summary.totalHours += t.hours;
            summary.byStatus[t.status] = (summary.byStatus[t.status] || 0) + 1;

            if (t.status === 'approved') {
                summary.approvedHours += t.hours;
            } else if (t.status === 'pending') {
                summary.pendingHours += t.hours;
            } else if (t.status === 'rejected') {
                summary.rejectedHours += t.hours;
            }

            // By project
            if (!summary.byProject[t.projectId]) {
                summary.byProject[t.projectId] = {
                    projectName: t.projectName,
                    totalHours: 0,
                    entries: 0
                };
            }
            summary.byProject[t.projectId].totalHours += t.hours;
            summary.byProject[t.projectId].entries += 1;
        });

        return res.status(200).json({
            success: true,
            data: summary
        });

    } catch (error) {
        console.error('Timesheet summary error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get summary',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/timesheets/:id - Update timesheet
// ============================================
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const timesheet = await getItem(process.env.TIMESHEETS_TABLE, { id });

        if (!timesheet) {
            return res.status(404).json({
                success: false,
                error: 'Timesheet not found'
            });
        }

        // Only owner can edit, and only if pending
        if (timesheet.userId !== req.user.uid) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        if (timesheet.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: 'Cannot edit approved/rejected timesheets'
            });
        }

        const updates = {
            ...req.body,
            updatedAt: timestamp()
        };

        // Remove protected fields
        delete updates.id;
        delete updates.userId;
        delete updates.status;
        delete updates.approvedBy;
        delete updates.approvedAt;
        delete updates.createdAt;

        const updatedTimesheet = await updateItem(
            process.env.TIMESHEETS_TABLE,
            { id },
            updates
        );

        return res.status(200).json({
            success: true,
            message: 'Timesheet updated successfully',
            data: updatedTimesheet
        });

    } catch (error) {
        console.error('Update timesheet error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to update timesheet',
            message: error.message
        });
    }
});

// ============================================
// DELETE /api/timesheets/:id - Delete timesheet
// ============================================
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const timesheet = await getItem(process.env.TIMESHEETS_TABLE, { id });

        if (!timesheet) {
            return res.status(404).json({
                success: false,
                error: 'Timesheet not found'
            });
        }

        // Only owner or admin can delete
        const canDelete = 
            timesheet.userId === req.user.uid ||
            ['coo', 'director'].includes(req.user.role);

        if (!canDelete) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        if (timesheet.status === 'approved') {
            return res.status(400).json({
                success: false,
                error: 'Cannot delete approved timesheets'
            });
        }

        await deleteItem(process.env.TIMESHEETS_TABLE, { id });

        return res.status(200).json({
            success: true,
            message: 'Timesheet deleted successfully'
        });

    } catch (error) {
        console.error('Delete timesheet error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to delete timesheet',
            message: error.message
        });
    }
});

module.exports = router;
