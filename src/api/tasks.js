// src/api/tasks.js - Task Management API with AWS DynamoDB
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
    timestamp 
} = require('../utils/dynamodb');

const router = express.Router();
router.use(verifyToken);

// ============================================
// POST /api/tasks - Create task
// ============================================
router.post('/', async (req, res) => {
    try {
        const {
            projectId,
            title,
            description,
            assignedTo,
            dueDate,
            priority // low, medium, high
        } = req.body;

        if (!projectId || !title) {
            return res.status(400).json({
                success: false,
                error: 'Project ID and title are required'
            });
        }

        const project = await getItem(process.env.PROJECTS_TABLE, { id: projectId });
        if (!project) {
            return res.status(404).json({
                success: false,
                error: 'Project not found'
            });
        }

        // Check permissions
        const canCreate = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            project.designLeadUid === req.user.uid;

        if (!canCreate) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        const taskId = generateId();
        const taskData = {
            id: taskId,
            projectId,
            projectName: project.projectName,
            title,
            description: description || '',
            assignedTo: assignedTo || null,
            assignedToName: null,
            dueDate: dueDate || null,
            priority: priority || 'medium',
            status: 'todo', // todo, in_progress, review, completed
            createdBy: req.user.name,
            createdByUid: req.user.uid,
            createdAt: timestamp(),
            updatedAt: timestamp(),
            completedAt: null
        };

        // Get assigned user name
        if (assignedTo) {
            const assignedUser = await getItem(process.env.USERS_TABLE, { uid: assignedTo });
            if (assignedUser) {
                taskData.assignedToName = assignedUser.name;
            }
        }

        await putItem(process.env.TASKS_TABLE, taskData);

        return res.status(201).json({
            success: true,
            message: 'Task created successfully',
            data: taskData
        });

    } catch (error) {
        console.error('Create task error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to create task',
            message: error.message
        });
    }
});

// ============================================
// GET /api/tasks - List tasks
// ============================================
router.get('/', async (req, res) => {
    try {
        const { projectId, assignedTo, status, id } = req.query;

        if (id) {
            const task = await getItem(process.env.TASKS_TABLE, { id });
            return task 
                ? res.status(200).json({ success: true, data: task })
                : res.status(404).json({ success: false, error: 'Task not found' });
        }

        let tasks = [];

        if (projectId) {
            tasks = await queryByIndex(
                process.env.TASKS_TABLE,
                'projectId-index',
                {
                    expression: 'projectId = :projectId',
                    values: { ':projectId': projectId }
                }
            );
        } else if (assignedTo || req.user.role === 'designer') {
            const targetUserId = assignedTo || req.user.uid;
            tasks = await queryByIndex(
                process.env.TASKS_TABLE,
                'assignedTo-index',
                {
                    expression: 'assignedTo = :uid',
                    values: { ':uid': targetUserId }
                }
            );
        } else if (['coo', 'director'].includes(req.user.role)) {
            tasks = await scanTable(process.env.TASKS_TABLE);
        } else {
            return res.status(403).json({ success: false, error: 'Access denied' });
        }

        if (status) {
            tasks = tasks.filter(t => t.status === status);
        }

        tasks.sort((a, b) => b.createdAt - a.createdAt);

        return res.status(200).json({
            success: true,
            data: tasks,
            count: tasks.length
        });

    } catch (error) {
        console.error('List tasks error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch tasks',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/tasks/:id/status - Update task status
// ============================================
router.put('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const validStatuses = ['todo', 'in_progress', 'review', 'completed'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid status'
            });
        }

        const task = await getItem(process.env.TASKS_TABLE, { id });
        if (!task) {
            return res.status(404).json({
                success: false,
                error: 'Task not found'
            });
        }

        const updates = {
            status,
            updatedAt: timestamp()
        };

        if (status === 'completed') {
            updates.completedAt = timestamp();
        }

        await updateItem(process.env.TASKS_TABLE, { id }, updates);

        return res.status(200).json({
            success: true,
            message: 'Task status updated'
        });

    } catch (error) {
        console.error('Update task status error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to update task status',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/tasks/:id - Update task
// ============================================
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const task = await getItem(process.env.TASKS_TABLE, { id });

        if (!task) {
            return res.status(404).json({
                success: false,
                error: 'Task not found'
            });
        }

        const updates = {
            ...req.body,
            updatedAt: timestamp()
        };

        delete updates.id;
        delete updates.projectId;
        delete updates.createdAt;
        delete updates.createdBy;

        const updatedTask = await updateItem(process.env.TASKS_TABLE, { id }, updates);

        return res.status(200).json({
            success: true,
            message: 'Task updated successfully',
            data: updatedTask
        });

    } catch (error) {
        console.error('Update task error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to update task',
            message: error.message
        });
    }
});

// ============================================
// DELETE /api/tasks/:id - Delete task
// ============================================
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const task = await getItem(process.env.TASKS_TABLE, { id });

        if (!task) {
            return res.status(404).json({
                success: false,
                error: 'Task not found'
            });
        }

        const canDelete = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            task.createdByUid === req.user.uid;

        if (!canDelete) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        await deleteItem(process.env.TASKS_TABLE, { id });

        return res.status(200).json({
            success: true,
            message: 'Task deleted successfully'
        });

    } catch (error) {
        console.error('Delete task error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to delete task',
            message: error.message
        });
    }
});

module.exports = router;
