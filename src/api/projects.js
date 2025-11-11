// src/api/projects.js - Projects API with AWS DynamoDB
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

// Apply authentication middleware
router.use(verifyToken);

// ============================================
// POST /api/projects - Create new project
// ============================================
router.post('/', async (req, res) => {
    try {
        // Only COO can create projects
        if (req.user.role !== 'coo') {
            return res.status(403).json({
                success: false,
                error: 'Only COO can create projects'
            });
        }

        const {
            projectName,
            projectCode,
            clientCompany,
            clientContact,
            clientEmail,
            proposalId,
            quoteValue,
            currency,
            allocatedHours,
            deadline,
            scopeOfWork,
            deliverables
        } = req.body;

        // Validate required fields
        if (!projectName || !clientCompany || !allocatedHours) {
            return res.status(400).json({
                success: false,
                error: 'Project name, client company, and allocated hours are required'
            });
        }

        const projectId = generateId();
        const projectData = {
            id: projectId,
            projectName,
            projectCode: projectCode || `PROJ-${Date.now()}`,
            clientCompany,
            clientContact: clientContact || '',
            clientEmail: clientEmail || '',
            proposalId: proposalId || null,
            
            // Financial
            quoteValue: quoteValue ? parseFloat(quoteValue) : 0,
            currency: currency || 'USD',
            
            // Time tracking
            allocatedHours: parseFloat(allocatedHours),
            usedHours: 0,
            remainingHours: parseFloat(allocatedHours),
            
            // Project details
            deadline: deadline || null,
            scopeOfWork: scopeOfWork || '',
            deliverables: deliverables || [],
            
            // Status
            status: 'active', // active, on_hold, completed, cancelled
            progressPercentage: 0,
            
            // Design team
            designLeadUid: null,
            designLeadName: null,
            assignedDesignerUids: [],
            assignedDesignerNames: [],
            
            // Timestamps
            createdBy: req.user.name,
            createdByUid: req.user.uid,
            createdAt: timestamp(),
            updatedAt: timestamp(),
            startDate: timestamp(),
            completionDate: null
        };

        await putItem(process.env.PROJECTS_TABLE, projectData);

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'project_created',
            details: `Project "${projectName}" created by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: projectId
        });

        return res.status(201).json({
            success: true,
            message: 'Project created successfully',
            data: projectData
        });

    } catch (error) {
        console.error('Create project error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to create project',
            message: error.message
        });
    }
});

// ============================================
// GET /api/projects - List projects
// ============================================
router.get('/', async (req, res) => {
    try {
        const { status, id } = req.query;

        // Get single project
        if (id) {
            const project = await getItem(process.env.PROJECTS_TABLE, { id });
            
            if (!project) {
                return res.status(404).json({
                    success: false,
                    error: 'Project not found'
                });
            }

            // Check permissions
            const canView = 
                req.user.role === 'coo' ||
                req.user.role === 'director' ||
                project.designLeadUid === req.user.uid ||
                project.assignedDesignerUids?.includes(req.user.uid);

            if (!canView) {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied'
                });
            }

            return res.status(200).json({
                success: true,
                data: project
            });
        }

        // List projects based on role
        let projects = [];

        if (req.user.role === 'coo' || req.user.role === 'director') {
            // Admin users can see all projects
            projects = await scanTable(process.env.PROJECTS_TABLE);
        } else if (req.user.role === 'design_manager') {
            // Design managers see projects they lead
            projects = await queryByIndex(
                process.env.PROJECTS_TABLE,
                'designLeadUid-index',
                {
                    expression: 'designLeadUid = :uid',
                    values: { ':uid': req.user.uid }
                }
            );
        } else if (req.user.role === 'designer') {
            // Designers see projects they're assigned to
            const allProjects = await scanTable(process.env.PROJECTS_TABLE);
            projects = allProjects.filter(p => 
                p.assignedDesignerUids?.includes(req.user.uid)
            );
        }

        // Filter by status if provided
        if (status) {
            projects = projects.filter(p => p.status === status);
        }

        // Sort by creation date (newest first)
        projects.sort((a, b) => b.createdAt - a.createdAt);

        return res.status(200).json({
            success: true,
            data: projects,
            count: projects.length
        });

    } catch (error) {
        console.error('List projects error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch projects',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/projects/:id/allocate - Allocate design lead
// ============================================
router.put('/:id/allocate', async (req, res) => {
    try {
        // Only COO can allocate design leads
        if (req.user.role !== 'coo') {
            return res.status(403).json({
                success: false,
                error: 'Only COO can allocate design leads'
            });
        }

        const { id } = req.params;
        const { designLeadUid } = req.body;

        if (!designLeadUid) {
            return res.status(400).json({
                success: false,
                error: 'Design lead UID is required'
            });
        }

        const project = await getItem(process.env.PROJECTS_TABLE, { id });

        if (!project) {
            return res.status(404).json({
                success: false,
                error: 'Project not found'
            });
        }

        // Get design lead details
        const designLead = await getItem(process.env.USERS_TABLE, { uid: designLeadUid });

        if (!designLead || designLead.role !== 'design_manager') {
            return res.status(404).json({
                success: false,
                error: 'Design manager not found'
            });
        }

        // Update project
        const updatedProject = await updateItem(
            process.env.PROJECTS_TABLE,
            { id },
            {
                designLeadUid: designLeadUid,
                designLeadName: designLead.name,
                updatedAt: timestamp()
            }
        );

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'design_lead_allocated',
            details: `Design lead ${designLead.name} allocated to project "${project.projectName}"`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: id
        });

        // Send email notification
        await sendNotificationEmail(
            [designLead.email],
            'projectAllocated',
            {
                projectName: project.projectName,
                projectCode: project.projectCode,
                clientCompany: project.clientCompany,
                allocatedHours: project.allocatedHours,
                deadline: project.deadline,
                loginUrl: process.env.FRONTEND_URL
            }
        );

        return res.status(200).json({
            success: true,
            message: 'Design lead allocated successfully',
            data: updatedProject
        });

    } catch (error) {
        console.error('Allocate design lead error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to allocate design lead',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/projects/:id/assign-designers - Assign designers
// ============================================
router.put('/:id/assign-designers', async (req, res) => {
    try {
        const { id } = req.params;
        const { designerUids } = req.body;

        if (!Array.isArray(designerUids) || designerUids.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Designer UIDs array is required'
            });
        }

        const project = await getItem(process.env.PROJECTS_TABLE, { id });

        if (!project) {
            return res.status(404).json({
                success: false,
                error: 'Project not found'
            });
        }

        // Check permissions (COO or Design Lead of this project)
        const canAssign = 
            req.user.role === 'coo' ||
            project.designLeadUid === req.user.uid;

        if (!canAssign) {
            return res.status(403).json({
                success: false,
                error: 'Only COO or project design lead can assign designers'
            });
        }

        // Get designer details
        const designers = [];
        for (const uid of designerUids) {
            const designer = await getItem(process.env.USERS_TABLE, { uid });
            if (designer && designer.role === 'designer') {
                designers.push(designer);
            }
        }

        if (designers.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No valid designers found'
            });
        }

        // Update project
        const updatedProject = await updateItem(
            process.env.PROJECTS_TABLE,
            { id },
            {
                assignedDesignerUids: designers.map(d => d.uid),
                assignedDesignerNames: designers.map(d => d.name),
                updatedAt: timestamp()
            }
        );

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'designers_assigned',
            details: `${designers.length} designer(s) assigned to project "${project.projectName}"`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: id
        });

        // Send email to each designer
        for (const designer of designers) {
            await sendNotificationEmail(
                [designer.email],
                'designerAssigned',
                {
                    projectName: project.projectName,
                    projectCode: project.projectCode,
                    designLead: project.designLeadName,
                    loginUrl: process.env.FRONTEND_URL
                }
            );
        }

        return res.status(200).json({
            success: true,
            message: 'Designers assigned successfully',
            data: updatedProject
        });

    } catch (error) {
        console.error('Assign designers error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to assign designers',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/projects/:id/status - Update project status
// ============================================
router.put('/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const validStatuses = ['active', 'on_hold', 'completed', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid status. Must be: active, on_hold, completed, or cancelled'
            });
        }

        const project = await getItem(process.env.PROJECTS_TABLE, { id });

        if (!project) {
            return res.status(404).json({
                success: false,
                error: 'Project not found'
            });
        }

        // Check permissions
        const canUpdate = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            project.designLeadUid === req.user.uid;

        if (!canUpdate) {
            return res.status(403).json({
                success: false,
                error: 'Insufficient permissions'
            });
        }

        const updates = {
            status,
            updatedAt: timestamp()
        };

        // Set completion date if status is completed
        if (status === 'completed' && project.status !== 'completed') {
            updates.completionDate = timestamp();
        }

        const updatedProject = await updateItem(
            process.env.PROJECTS_TABLE,
            { id },
            updates
        );

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'project_status_updated',
            details: `Project "${project.projectName}" status changed to ${status}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: id
        });

        return res.status(200).json({
            success: true,
            message: 'Project status updated successfully',
            data: updatedProject
        });

    } catch (error) {
        console.error('Update project status error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to update project status',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/projects/:id/hours - Update used hours
// ============================================
router.put('/:id/hours', async (req, res) => {
    try {
        const { id } = req.params;
        const { hours, operation } = req.body; // operation: 'add' or 'set'

        if (!hours || !operation) {
            return res.status(400).json({
                success: false,
                error: 'Hours and operation are required'
            });
        }

        const project = await getItem(process.env.PROJECTS_TABLE, { id });

        if (!project) {
            return res.status(404).json({
                success: false,
                error: 'Project not found'
            });
        }

        let newUsedHours;
        if (operation === 'add') {
            // Increment hours
            const updated = await incrementField(
                process.env.PROJECTS_TABLE,
                { id },
                'usedHours',
                parseFloat(hours)
            );
            newUsedHours = updated.usedHours;
        } else if (operation === 'set') {
            // Set absolute value
            newUsedHours = parseFloat(hours);
            await updateItem(
                process.env.PROJECTS_TABLE,
                { id },
                { usedHours: newUsedHours }
            );
        } else {
            return res.status(400).json({
                success: false,
                error: 'Operation must be "add" or "set"'
            });
        }

        // Calculate remaining hours and progress
        const remainingHours = project.allocatedHours - newUsedHours;
        const progressPercentage = Math.min(
            Math.round((newUsedHours / project.allocatedHours) * 100),
            100
        );

        await updateItem(
            process.env.PROJECTS_TABLE,
            { id },
            {
                remainingHours,
                progressPercentage,
                updatedAt: timestamp()
            }
        );

        return res.status(200).json({
            success: true,
            message: 'Project hours updated successfully',
            data: {
                usedHours: newUsedHours,
                remainingHours,
                progressPercentage
            }
        });

    } catch (error) {
        console.error('Update project hours error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to update project hours',
            message: error.message
        });
    }
});

// ============================================
// PUT /api/projects/:id - Update project
// ============================================
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const project = await getItem(process.env.PROJECTS_TABLE, { id });

        if (!project) {
            return res.status(404).json({
                success: false,
                error: 'Project not found'
            });
        }

        // Check permissions
        const canEdit = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            project.designLeadUid === req.user.uid;

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
        delete updates.createdBy;
        delete updates.createdByUid;
        delete updates.createdAt;
        delete updates.usedHours; // Use separate endpoint for hours

        const updatedProject = await updateItem(
            process.env.PROJECTS_TABLE,
            { id },
            updates
        );

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'project_updated',
            details: `Project "${project.projectName}" updated by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: id
        });

        return res.status(200).json({
            success: true,
            message: 'Project updated successfully',
            data: updatedProject
        });

    } catch (error) {
        console.error('Update project error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to update project',
            message: error.message
        });
    }
});

// ============================================
// DELETE /api/projects/:id - Delete project
// ============================================
router.delete('/:id', async (req, res) => {
    try {
        // Only COO/Director can delete projects
        if (req.user.role !== 'coo' && req.user.role !== 'director') {
            return res.status(403).json({
                success: false,
                error: 'Only COO/Director can delete projects'
            });
        }

        const { id } = req.params;
        const project = await getItem(process.env.PROJECTS_TABLE, { id });

        if (!project) {
            return res.status(404).json({
                success: false,
                error: 'Project not found'
            });
        }

        await deleteItem(process.env.PROJECTS_TABLE, { id });

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'project_deleted',
            details: `Project "${project.projectName}" deleted by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: id
        });

        return res.status(200).json({
            success: true,
            message: 'Project deleted successfully'
        });

    } catch (error) {
        console.error('Delete project error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to delete project',
            message: error.message
        });
    }
});

module.exports = router;
