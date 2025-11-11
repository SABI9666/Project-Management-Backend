// src/api/time-requests.js - Time Off Requests API with AWS DynamoDB
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
const { sendNotificationEmail } = require('../utils/email');

const router = express.Router();
router.use(verifyToken);

// ============================================
// POST /api/time-requests - Submit time-off request
// ============================================
router.post('/', async (req, res) => {
    try {
        const {
            startDate,
            endDate,
            reason,
            type // sick, vacation, personal, unpaid
        } = req.body;

        // Validate
        if (!startDate || !endDate || !type) {
            return res.status(400).json({
                success: false,
                error: 'Start date, end date, and type are required'
            });
        }

        const start = typeof startDate === 'number' ? startDate : parseInt(startDate);
        const end = typeof endDate === 'number' ? endDate : parseInt(endDate);

        if (end < start) {
            return res.status(400).json({
                success: false,
                error: 'End date must be after start date'
            });
        }

        // Calculate days
        const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
        const days = daysDiff + 1;

        const requestId = generateId();
        const requestData = {
            id: requestId,
            
            userId: req.user.uid,
            userName: req.user.name,
            userEmail: req.user.email,
            userRole: req.user.role,
            
            startDate: start,
            endDate: end,
            days: days,
            type: type,
            reason: reason || '',
            
            status: 'pending', // pending, approved, rejected
            reviewedBy: null,
            reviewedByUid: null,
            reviewedAt: null,
            reviewNotes: null,
            
            createdAt: timestamp(),
            updatedAt: timestamp()
        };

        await putItem(process.env.TIME_REQUESTS_TABLE, requestData);

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'time_request_submitted',
            details: `${req.user.name} requested ${days} day(s) off (${type})`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            timeRequestId: requestId
        });

        // Notify managers
        const managers = await queryByIndex(
            process.env.USERS_TABLE,
            'role-index',
            {
                expression: '#role = :coo OR #role = :director',
                names: { '#role': 'role' },
                values: { ':coo': 'coo', ':director': 'director' }
            }
        );

        if (managers && managers.length > 0) {
            const managerEmails = managers.map(m => m.email);
            await sendNotificationEmail(
                managerEmails,
                'timeRequestSubmitted',
                {
                    userName: req.user.name,
                    type: type,
                    startDate: new Date(start * 1000).toLocaleDateString(),
                    endDate: new Date(end * 1000).toLocaleDateString(),
                    days: days,
                    reason: reason || 'No reason provided',
                    loginUrl: process.env.FRONTEND_URL
                }
            );
        }

        return res.status(201).json({
            success: true,
            message: 'Time-off request submitted successfully',
            data: requestData
        });

    } catch (error) {
        console.error('Submit time request error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to submit time-off request',
            message: error.message
        });
    }
});

// ============================================
// GET /api/time-requests - List time-off requests
// ============================================
router.get('/', async (req, res) => {
    try {
        const { userId, status, id } = req.query;

        // Get single request
        if (id) {
            const request = await getItem(process.env.TIME_REQUESTS_TABLE, { id });
            
            if (!request) {
                return res.status(404).json({
                    success: false,
                    error: 'Request not found'
                });
            }

            // Check permissions
            const canView = 
                req.user.role === 'coo' ||
                req.user.role === 'director' ||
                request.userId === req.user.uid;

            if (!canView) {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied'
                });
            }

            return res.status(200).json({
                success: true,
                data: request
            });
        }

        let requests = [];

        // Query by user
        if (userId || req.user.role === 'designer' || req.user.role === 'design_manager') {
            const targetUserId = userId || req.user.uid;

            // Only admins can see other users' requests
            if (userId && userId !== req.user.uid && !['coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied'
                });
            }

            requests = await queryByIndex(
                process.env.TIME_REQUESTS_TABLE,
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
            requests = await scanTable(process.env.TIME_REQUESTS_TABLE);
        }

        // Filter by status
        if (status) {
            requests = requests.filter(r => r.status === status);
        }

        // Sort by creation date (newest first)
        requests.sort((a, b) => b.createdAt - a.createdAt);

        return res.status(200).json({
            success: true,
            data: requests,
            count: requests.length
        });

    } catch (error) {
        console.error('List time requests error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch time-off requests',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/time-requests/:id/approve - Approve request
// ============================================
router.put('/:id/approve', async (req, res) => {
    try {
        // Only COO/Director can approve
        if (req.user.role !== 'coo' && req.user.role !== 'director') {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director can approve time-off requests'
            });
        }

        const { id } = req.params;
        const { notes } = req.body;

        const request = await getItem(process.env.TIME_REQUESTS_TABLE, { id });

        if (!request) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: 'Request has already been processed'
            });
        }

        // Update request
        const updatedRequest = await updateItem(
            process.env.TIME_REQUESTS_TABLE,
            { id },
            {
                status: 'approved',
                reviewedBy: req.user.name,
                reviewedByUid: req.user.uid,
                reviewedAt: timestamp(),
                reviewNotes: notes || null,
                updatedAt: timestamp()
            }
        );

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'time_request_approved',
            details: `Time-off request for ${request.userName} approved by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            timeRequestId: id
        });

        // Send email to employee
        await sendNotificationEmail(
            [request.userEmail],
            'timeRequestApproved',
            {
                userName: request.userName,
                type: request.type,
                startDate: new Date(request.startDate * 1000).toLocaleDateString(),
                endDate: new Date(request.endDate * 1000).toLocaleDateString(),
                days: request.days,
                approvedBy: req.user.name,
                notes: notes || '',
                loginUrl: process.env.FRONTEND_URL
            }
        );

        return res.status(200).json({
            success: true,
            message: 'Time-off request approved',
            data: updatedRequest
        });

    } catch (error) {
        console.error('Approve time request error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to approve request',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/time-requests/:id/reject - Reject request
// ============================================
router.put('/:id/reject', async (req, res) => {
    try {
        if (req.user.role !== 'coo' && req.user.role !== 'director') {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director can reject time-off requests'
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

        const request = await getItem(process.env.TIME_REQUESTS_TABLE, { id });

        if (!request) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: 'Request has already been processed'
            });
        }

        // Update request
        const updatedRequest = await updateItem(
            process.env.TIME_REQUESTS_TABLE,
            { id },
            {
                status: 'rejected',
                reviewedBy: req.user.name,
                reviewedByUid: req.user.uid,
                reviewedAt: timestamp(),
                reviewNotes: reason,
                updatedAt: timestamp()
            }
        );

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'time_request_rejected',
            details: `Time-off request for ${request.userName} rejected by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            timeRequestId: id
        });

        // Send email to employee
        await sendNotificationEmail(
            [request.userEmail],
            'timeRequestRejected',
            {
                userName: request.userName,
                type: request.type,
                startDate: new Date(request.startDate * 1000).toLocaleDateString(),
                endDate: new Date(request.endDate * 1000).toLocaleDateString(),
                rejectedBy: req.user.name,
                reason: reason,
                loginUrl: process.env.FRONTEND_URL
            }
        );

        return res.status(200).json({
            success: true,
            message: 'Time-off request rejected',
            data: updatedRequest
        });

    } catch (error) {
        console.error('Reject time request error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to reject request',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/time-requests/:id - Update request
// ============================================
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const request = await getItem(process.env.TIME_REQUESTS_TABLE, { id });

        if (!request) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Only owner can edit, and only if pending
        if (request.userId !== req.user.uid) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: 'Cannot edit approved/rejected requests'
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
        delete updates.reviewedBy;
        delete updates.createdAt;

        // Recalculate days if dates changed
        if (updates.startDate || updates.endDate) {
            const start = updates.startDate || request.startDate;
            const end = updates.endDate || request.endDate;
            const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
            updates.days = daysDiff + 1;
        }

        const updatedRequest = await updateItem(
            process.env.TIME_REQUESTS_TABLE,
            { id },
            updates
        );

        return res.status(200).json({
            success: true,
            message: 'Request updated successfully',
            data: updatedRequest
        });

    } catch (error) {
        console.error('Update time request error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to update request',
            message: error.message
        });
    }
});

// ============================================
// DELETE /api/time-requests/:id - Delete request
// ============================================
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const request = await getItem(process.env.TIME_REQUESTS_TABLE, { id });

        if (!request) {
            return res.status(404).json({
                success: false,
                error: 'Request not found'
            });
        }

        // Only owner or admin can delete
        const canDelete = 
            request.userId === req.user.uid ||
            ['coo', 'director'].includes(req.user.role);

        if (!canDelete) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        // Can only delete pending requests
        if (request.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: 'Cannot delete approved/rejected requests'
            });
        }

        await deleteItem(process.env.TIME_REQUESTS_TABLE, { id });

        return res.status(200).json({
            success: true,
            message: 'Request deleted successfully'
        });

    } catch (error) {
        console.error('Delete time request error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to delete request',
            message: error.message
        });
    }
});

module.exports = router;
