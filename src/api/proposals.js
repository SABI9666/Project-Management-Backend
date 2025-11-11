// src/api/proposals.js - Proposals API with AWS DynamoDB
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

// Apply authentication middleware
router.use(verifyToken);

// ============================================
// POST /api/proposals - Create new proposal
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

        // Validate required fields
        if (!projectName || !clientCompany || !estimatedValue) {
            return res.status(400).json({
                success: false,
                error: 'Project name, client company, and estimated value are required'
            });
        }

        const proposalId = generateId();
        const proposalData = {
            id: proposalId,
            projectName,
            clientCompany,
            clientContact: clientContact || '',
            clientEmail: clientEmail || '',
            clientPhone: clientPhone || '',
            projectDescription: projectDescription || '',
            estimatedValue: parseFloat(estimatedValue),
            currency: currency || 'USD',
            proposedTimeline: proposedTimeline || '',
            deliverables: deliverables || [],
            scopeOfWork: scopeOfWork || '',
            specialRequirements: specialRequirements || '',
            
            // Status tracking
            status: 'pending', // pending, approved, rejected
            
            // User tracking
            submittedBy: req.user.name,
            submittedByUid: req.user.uid,
            submittedByEmail: req.user.email,
            submittedAt: timestamp(),
            
            // Approval tracking
            reviewedBy: null,
            reviewedByUid: null,
            reviewedAt: null,
            reviewNotes: null,
            
            // Pricing tracking
            pricingStatus: 'pending', // pending, in_progress, completed
            assignedEstimatorUid: null,
            assignedEstimatorName: null,
            quoteValue: null,
            quoteCurrency: null,
            
            // Timestamps
            createdAt: timestamp(),
            updatedAt: timestamp()
        };

        await putItem(process.env.PROPOSALS_TABLE, proposalData);

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'proposal_submitted',
            details: `Proposal submitted for "${projectName}" by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            proposalId: proposalId
        });

        // Send email notification to COO/Director
        const adminUsers = await queryByIndex(
            process.env.USERS_TABLE,
            'role-index',
            {
                expression: '#role = :coo OR #role = :director',
                names: { '#role': 'role' },
                values: { ':coo': 'coo', ':director': 'director' }
            }
        );

        if (adminUsers.length > 0) {
            const adminEmails = adminUsers.map(u => u.email);
            await sendNotificationEmail(
                adminEmails,
                'proposalSubmitted',
                {
                    projectName,
                    clientCompany,
                    estimatedValue,
                    currency: currency || 'USD',
                    submittedBy: req.user.name,
                    loginUrl: process.env.FRONTEND_URL
                }
            );
        }

        return res.status(201).json({
            success: true,
            message: 'Proposal submitted successfully',
            data: { id: proposalId, ...proposalData }
        });

    } catch (error) {
        console.error('Create proposal error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to create proposal',
            message: error.message
        });
    }
});

// ============================================
// GET /api/proposals - List proposals
// ============================================
router.get('/', async (req, res) => {
    try {
        const { status, id } = req.query;

        // Get single proposal
        if (id) {
            const proposal = await getItem(process.env.PROPOSALS_TABLE, { id });
            
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
            // Admin users can see all proposals
            proposals = await scanTable(process.env.PROPOSALS_TABLE);
        } else if (req.user.role === 'bdm') {
            // BDM can only see their own proposals
            proposals = await queryByIndex(
                process.env.PROPOSALS_TABLE,
                'submittedByUid-index',
                {
                    expression: 'submittedByUid = :uid',
                    values: { ':uid': req.user.uid }
                }
            );
        }

        // Filter by status if provided
        if (status) {
            proposals = proposals.filter(p => p.status === status);
        }

        // Sort by submission date (newest first)
        proposals.sort((a, b) => b.submittedAt - a.submittedAt);

        return res.status(200).json({
            success: true,
            data: proposals,
            count: proposals.length
        });

    } catch (error) {
        console.error('List proposals error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch proposals',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/proposals/:id/review - Approve/Reject proposal
// ============================================
router.put('/:id/review', async (req, res) => {
    try {
        // Only COO/Director can review
        if (req.user.role !== 'coo' && req.user.role !== 'director') {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director can review proposals'
            });
        }

        const { id } = req.params;
        const { status, notes } = req.body; // status: 'approved' or 'rejected'

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({
                success: false,
                error: 'Status must be either "approved" or "rejected"'
            });
        }

        const proposal = await getItem(process.env.PROPOSALS_TABLE, { id });

        if (!proposal) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        if (proposal.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: 'Proposal has already been reviewed'
            });
        }

        // Update proposal
        const updatedProposal = await updateItem(
            process.env.PROPOSALS_TABLE,
            { id },
            {
                status,
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
            type: status === 'approved' ? 'proposal_approved' : 'proposal_rejected',
            details: `Proposal "${proposal.projectName}" ${status} by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            proposalId: id
        });

        // Send email to submitter
        const templateName = status === 'approved' ? 'proposalApproved' : 'proposalRejected';
        await sendNotificationEmail(
            [proposal.submittedByEmail],
            templateName,
            {
                projectName: proposal.projectName,
                clientCompany: proposal.clientCompany,
                approvedBy: req.user.name,
                rejectedBy: req.user.name,
                notes: notes || '',
                reason: notes || '',
                loginUrl: process.env.FRONTEND_URL
            }
        );

        return res.status(200).json({
            success: true,
            message: `Proposal ${status} successfully`,
            data: updatedProposal
        });

    } catch (error) {
        console.error('Review proposal error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to review proposal',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/proposals/:id/assign-estimator - Assign estimator
// ============================================
router.put('/:id/assign-estimator', async (req, res) => {
    try {
        // Only COO can assign estimators
        if (req.user.role !== 'coo') {
            return res.status(403).json({
                success: false,
                error: 'Only COO can assign estimators'
            });
        }

        const { id } = req.params;
        const { estimatorUid } = req.body;

        if (!estimatorUid) {
            return res.status(400).json({
                success: false,
                error: 'Estimator UID is required'
            });
        }

        const proposal = await getItem(process.env.PROPOSALS_TABLE, { id });

        if (!proposal) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        if (proposal.status !== 'approved') {
            return res.status(400).json({
                success: false,
                error: 'Can only assign estimator to approved proposals'
            });
        }

        // Get estimator details
        const estimator = await getItem(process.env.USERS_TABLE, { uid: estimatorUid });

        if (!estimator || estimator.role !== 'estimator') {
            return res.status(404).json({
                success: false,
                error: 'Estimator not found'
            });
        }

        // Update proposal
        const updatedProposal = await updateItem(
            process.env.PROPOSALS_TABLE,
            { id },
            {
                assignedEstimatorUid: estimatorUid,
                assignedEstimatorName: estimator.name,
                pricingStatus: 'in_progress',
                updatedAt: timestamp()
            }
        );

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'estimator_assigned',
            details: `Estimator ${estimator.name} assigned to proposal "${proposal.projectName}"`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            proposalId: id
        });

        return res.status(200).json({
            success: true,
            message: 'Estimator assigned successfully',
            data: updatedProposal
        });

    } catch (error) {
        console.error('Assign estimator error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to assign estimator',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/proposals/:id/pricing - Complete pricing
// ============================================
router.put('/:id/pricing', async (req, res) => {
    try {
        // Only estimators can complete pricing
        if (req.user.role !== 'estimator') {
            return res.status(403).json({
                success: false,
                error: 'Only estimators can complete pricing'
            });
        }

        const { id } = req.params;
        const { quoteValue, currency } = req.body;

        if (!quoteValue) {
            return res.status(400).json({
                success: false,
                error: 'Quote value is required'
            });
        }

        const proposal = await getItem(process.env.PROPOSALS_TABLE, { id });

        if (!proposal) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        // Check if this estimator is assigned
        if (proposal.assignedEstimatorUid !== req.user.uid) {
            return res.status(403).json({
                success: false,
                error: 'You are not assigned to this proposal'
            });
        }

        // Update proposal
        const updatedProposal = await updateItem(
            process.env.PROPOSALS_TABLE,
            { id },
            {
                quoteValue: parseFloat(quoteValue),
                quoteCurrency: currency || proposal.currency || 'USD',
                pricingStatus: 'completed',
                updatedAt: timestamp()
            }
        );

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'pricing_completed',
            details: `Pricing completed for "${proposal.projectName}" by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            proposalId: id
        });

        // Send email to COO
        const cooUsers = await queryByIndex(
            process.env.USERS_TABLE,
            'role-index',
            {
                expression: '#role = :role',
                names: { '#role': 'role' },
                values: { ':role': 'coo' }
            }
        );

        if (cooUsers.length > 0) {
            const cooEmails = cooUsers.map(u => u.email);
            await sendNotificationEmail(
                cooEmails,
                'pricingCompleted',
                {
                    projectName: proposal.projectName,
                    quoteValue: quoteValue,
                    currency: currency || proposal.currency || 'USD',
                    completedBy: req.user.name,
                    loginUrl: process.env.FRONTEND_URL
                }
            );
        }

        return res.status(200).json({
            success: true,
            message: 'Pricing completed successfully',
            data: updatedProposal
        });

    } catch (error) {
        console.error('Complete pricing error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to complete pricing',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/proposals/:id - Update proposal
// ============================================
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const proposal = await getItem(process.env.PROPOSALS_TABLE, { id });

        if (!proposal) {
            return res.status(404).json({
                success: false,
                error: 'Proposal not found'
            });
        }

        // Check permissions
        const canEdit = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            (req.user.role === 'bdm' && proposal.submittedByUid === req.user.uid && proposal.status === 'pending');

        if (!canEdit) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        // Update allowed fields
        const updates = {
            ...req.body,
            updatedAt: timestamp()
        };

        // Remove protected fields
        delete updates.id;
        delete updates.submittedBy;
        delete updates.submittedByUid;
        delete updates.submittedAt;
        delete updates.createdAt;

        const updatedProposal = await updateItem(
            process.env.PROPOSALS_TABLE,
