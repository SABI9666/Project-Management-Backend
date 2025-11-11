// src/api/dashboard.js - Dashboard Stats API with AWS DynamoDB
const express = require('express');
const { verifyToken } = require('../middleware/auth');
const { getItem, queryByIndex, scanTable } = require('../utils/dynamodb');

const router = express.Router();
router.use(verifyToken);

// GET /api/dashboard/stats - Overall statistics
router.get('/stats', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const [projects, proposals, timesheets, users] = await Promise.all([
            scanTable(process.env.PROJECTS_TABLE),
            scanTable(process.env.PROPOSALS_TABLE),
            scanTable(process.env.TIMESHEETS_TABLE),
            scanTable(process.env.USERS_TABLE)
        ]);

        const stats = {
            projects: {
                total: projects.length,
                active: projects.filter(p => p.status === 'active').length,
                completed: projects.filter(p => p.status === 'completed').length,
                onHold: projects.filter(p => p.status === 'on_hold').length
            },
            proposals: {
                total: proposals.length,
                pending: proposals.filter(p => p.status === 'pending').length,
                approved: proposals.filter(p => p.status === 'approved').length,
                rejected: proposals.filter(p => p.status === 'rejected').length
            },
            timesheets: {
                total: timesheets.length,
                pending: timesheets.filter(t => t.status === 'pending').length,
                approved: timesheets.filter(t => t.status === 'approved').length,
                totalHours: timesheets.filter(t => t.status === 'approved').reduce((sum, t) => sum + t.hours, 0)
            },
            users: {
                total: users.length,
                byRole: {
                    coo: users.filter(u => u.role === 'coo').length,
                    director: users.filter(u => u.role === 'director').length,
                    bdm: users.filter(u => u.role === 'bdm').length,
                    estimator: users.filter(u => u.role === 'estimator').length,
                    design_manager: users.filter(u => u.role === 'design_manager').length,
                    designer: users.filter(u => u.role === 'designer').length
                }
            }
        };

        return res.status(200).json({ success: true, data: stats });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/dashboard/projects-summary - Projects summary
router.get('/projects-summary', async (req, res) => {
    try {
        const projects = await scanTable(process.env.PROJECTS_TABLE);

        const summary = {
            totalProjects: projects.length,
            byStatus: {
                active: projects.filter(p => p.status === 'active').length,
                completed: projects.filter(p => p.status === 'completed').length,
                onHold: projects.filter(p => p.status === 'on_hold').length,
                cancelled: projects.filter(p => p.status === 'cancelled').length
            },
            totalAllocatedHours: projects.reduce((sum, p) => sum + (p.allocatedHours || 0), 0),
            totalUsedHours: projects.reduce((sum, p) => sum + (p.usedHours || 0), 0),
            averageProgress: projects.length > 0 
                ? Math.round(projects.reduce((sum, p) => sum + (p.progressPercentage || 0), 0) / projects.length)
                : 0
        };

        return res.status(200).json({ success: true, data: summary });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/dashboard/recent-activities - Recent activities
router.get('/recent-activities', async (req, res) => {
    try {
        const { limit = 20 } = req.query;

        let activities = [];

        if (['coo', 'director'].includes(req.user.role)) {
            activities = await scanTable(process.env.ACTIVITIES_TABLE);
        } else {
            activities = await queryByIndex(process.env.ACTIVITIES_TABLE, 'performedByUid-index', {
                expression: 'performedByUid = :uid', values: { ':uid': req.user.uid }
            });
        }

        activities.sort((a, b) => b.timestamp - a.timestamp);
        activities = activities.slice(0, parseInt(limit));

        return res.status(200).json({ success: true, data: activities });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/dashboard/team-performance - Team metrics
router.get('/team-performance', async (req, res) => {
    try {
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        const [timesheets, projects] = await Promise.all([
            scanTable(process.env.TIMESHEETS_TABLE),
            scanTable(process.env.PROJECTS_TABLE)
        ]);

        const approvedTimesheets = timesheets.filter(t => t.status === 'approved');
        
        const userPerformance = {};
        approvedTimesheets.forEach(t => {
            if (!userPerformance[t.userId]) {
                userPerformance[t.userId] = {
                    userName: t.userName,
                    totalHours: 0,
                    entriesCount: 0
                };
            }
            userPerformance[t.userId].totalHours += t.hours;
            userPerformance[t.userId].entriesCount += 1;
        });

        const performance = Object.values(userPerformance).sort((a, b) => b.totalHours - a.totalHours);

        return res.status(200).json({ success: true, data: performance });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/dashboard/my-dashboard - User's personal dashboard
router.get('/my-dashboard', async (req, res) => {
    try {
        const userId = req.user.uid;

        const [myProjects, myTimesheets, myNotifications] = await Promise.all([
            (async () => {
                const allProjects = await scanTable(process.env.PROJECTS_TABLE);
                return allProjects.filter(p => 
                    p.designLeadUid === userId ||
                    (p.assignedDesignerUids || []).includes(userId)
                );
            })(),
            queryByIndex(process.env.TIMESHEETS_TABLE, 'userId-index', {
                expression: 'userId = :userId', values: { ':userId': userId }
            }),
            queryByIndex(process.env.NOTIFICATIONS_TABLE, 'userId-index', {
                expression: 'userId = :userId', values: { ':userId': userId }
            })
        ]);

        const dashboard = {
            projects: {
                total: myProjects.length,
                active: myProjects.filter(p => p.status === 'active').length
            },
            timesheets: {
                thisMonth: myTimesheets.filter(t => {
                    const date = new Date(t.date * 1000);
                    const now = new Date();
                    return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
                }).length,
                pending: myTimesheets.filter(t => t.status === 'pending').length
            },
            notifications: {
                unread: myNotifications.filter(n => !n.read).length
            }
        };

        return res.status(200).json({ success: true, data: dashboard });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
