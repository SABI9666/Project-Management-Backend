// src/api/notifications.js - Notifications API with AWS DynamoDB
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
// POST /api/notifications - Create notification (internal)
// ============================================
router.post('/', async (req, res) => {
    try {
        // Only system or admins can create notifications
        if (!['coo', 'director'].includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions'
            });
        }

        const {
            userId,
            title,
            message,
            type, // info, success, warning, error
            link
        } = req.body;

        if (!userId || !title || !message) {
            return res.status(400).json({
                success: false,
                error: 'User ID, title, and message are required'
            });
        }

        const notificationId = generateId();
        const notificationData = {
            id: notificationId,
            userId,
            title,
            message,
            type: type || 'info',
            link: link || null,
            read: false,
            readAt: null,
            createdAt: timestamp()
        };

        await putItem(process.env.NOTIFICATIONS_TABLE, notificationData);

        return res.status(201).json({
            success: true,
            message: 'Notification created',
            data: notificationData
        });

    } catch (error) {
        console.error('Create notification error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to create notification',
            message: error.message
        });
    }
});

// ============================================
// GET /api/notifications - List user's notifications
// ============================================
router.get('/', async (req, res) => {
    try {
        const { read, limit = 50 } = req.query;

        // Get user's notifications
        let notifications = await queryByIndex(
            process.env.NOTIFICATIONS_TABLE,
            'userId-index',
            {
                expression: 'userId = :userId',
                values: { ':userId': req.user.uid }
            }
        );

        // Filter by read status
        if (read !== undefined) {
            const isRead = read === 'true' || read === true;
            notifications = notifications.filter(n => n.read === isRead);
        }

        // Sort by creation date (newest first)
        notifications.sort((a, b) => b.createdAt - a.createdAt);

        // Limit results
        if (limit) {
            notifications = notifications.slice(0, parseInt(limit));
        }

        return res.status(200).json({
            success: true,
            data: notifications,
            count: notifications.length
        });

    } catch (error) {
        console.error('List notifications error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch notifications',
            message: error.message
        });
    }
});

// ============================================
// GET /api/notifications/unread - Get unread count
// ============================================
router.get('/unread', async (req, res) => {
    try {
        let notifications = await queryByIndex(
            process.env.NOTIFICATIONS_TABLE,
            'userId-index',
            {
                expression: 'userId = :userId',
                values: { ':userId': req.user.uid }
            }
        );

        const unreadCount = notifications.filter(n => !n.read).length;

        return res.status(200).json({
            success: true,
            data: {
                count: unreadCount
            }
        });

    } catch (error) {
        console.error('Get unread count error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get unread count',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/notifications/:id/read - Mark as read
// ============================================
router.put('/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        const notification = await getItem(process.env.NOTIFICATIONS_TABLE, { id });

        if (!notification) {
            return res.status(404).json({
                success: false,
                error: 'Notification not found'
            });
        }

        // Verify ownership
        if (notification.userId !== req.user.uid) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        if (notification.read) {
            return res.status(200).json({
                success: true,
                message: 'Notification already read'
            });
        }

        await updateItem(
            process.env.NOTIFICATIONS_TABLE,
            { id },
            {
                read: true,
                readAt: timestamp()
            }
        );

        return res.status(200).json({
            success: true,
            message: 'Notification marked as read'
        });

    } catch (error) {
        console.error('Mark read error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to mark notification as read',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/notifications/read-all - Mark all as read
// ============================================
router.put('/read-all', async (req, res) => {
    try {
        let notifications = await queryByIndex(
            process.env.NOTIFICATIONS_TABLE,
            'userId-index',
            {
                expression: 'userId = :userId',
                values: { ':userId': req.user.uid }
            }
        );

        // Filter unread
        const unreadNotifications = notifications.filter(n => !n.read);

        // Mark all as read
        for (const notification of unreadNotifications) {
            await updateItem(
                process.env.NOTIFICATIONS_TABLE,
                { id: notification.id },
                {
                    read: true,
                    readAt: timestamp()
                }
            );
        }

        return res.status(200).json({
            success: true,
            message: `${unreadNotifications.length} notifications marked as read`
        });

    } catch (error) {
        console.error('Mark all read error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to mark all as read',
            message: error.message
        });
    }
});

// ============================================
// DELETE /api/notifications/:id - Delete notification
// ============================================
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const notification = await getItem(process.env.NOTIFICATIONS_TABLE, { id });

        if (!notification) {
            return res.status(404).json({
                success: false,
                error: 'Notification not found'
            });
        }

        // Verify ownership
        if (notification.userId !== req.user.uid) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        await deleteItem(process.env.NOTIFICATIONS_TABLE, { id });

        return res.status(200).json({
            success: true,
            message: 'Notification deleted'
        });

    } catch (error) {
        console.error('Delete notification error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to delete notification',
            message: error.message
        });
    }
});

// ============================================
// DELETE /api/notifications/delete-all - Delete all read notifications
// ============================================
router.delete('/delete-all', async (req, res) => {
    try {
        let notifications = await queryByIndex(
            process.env.NOTIFICATIONS_TABLE,
            'userId-index',
            {
                expression: 'userId = :userId',
                values: { ':userId': req.user.uid }
            }
        );

        // Filter read notifications
        const readNotifications = notifications.filter(n => n.read);

        // Delete all read
        for (const notification of readNotifications) {
            await deleteItem(process.env.NOTIFICATIONS_TABLE, { id: notification.id });
        }

        return res.status(200).json({
            success: true,
            message: `${readNotifications.length} notifications deleted`
        });

    } catch (error) {
        console.error('Delete all error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to delete notifications',
            message: error.message
        });
    }
});

module.exports = router;
