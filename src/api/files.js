// src/api/files.js - Files API with AWS S3
const express = require('express');
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');
const { 
    uploadFile, 
    getSignedUrl, 
    deleteFile, 
    listFiles,
    getFileMetadata 
} = require('../utils/s3');
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

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB max
    }
});

// Apply authentication
router.use(verifyToken);

// ============================================
// POST /api/files/upload - Upload single file
// ============================================
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No file uploaded'
            });
        }

        const { projectId, category, description } = req.body;

        if (!projectId) {
            return res.status(400).json({
                success: false,
                error: 'Project ID is required'
            });
        }

        // Verify project exists
        const project = await getItem(process.env.PROJECTS_TABLE, { id: projectId });
        if (!project) {
            return res.status(404).json({
                success: false,
                error: 'Project not found'
            });
        }

        // Check permissions
        const hasAccess = 
            req.user.role === 'coo' || 
            req.user.role === 'director' ||
            project.designLeadUid === req.user.uid ||
            (project.assignedDesignerUids || []).includes(req.user.uid);

        if (!hasAccess) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        // Upload to S3
        const folder = `projects/${projectId}/${category || 'general'}`;
        const s3Result = await uploadFile(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
            folder
        );

        // Save metadata to DynamoDB
        const fileId = generateId();
        const fileData = {
            id: fileId,
            projectId: projectId,
            projectName: project.projectName,
            projectCode: project.projectCode,
            
            fileName: req.file.originalname,
            fileSize: req.file.size,
            mimeType: req.file.mimetype,
            category: category || 'general',
            description: description || '',
            
            s3Key: s3Result.key,
            s3Bucket: s3Result.bucket,
            
            uploadedBy: req.user.name,
            uploadedByUid: req.user.uid,
            uploadedByRole: req.user.role,
            uploadedAt: timestamp(),
            
            isDeleted: false
        };

        await putItem(process.env.FILES_TABLE, fileData);

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'file_uploaded',
            details: `File "${req.file.originalname}" uploaded to ${project.projectName}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: projectId,
            fileId: fileId
        });

        // Generate signed URL
        const signedUrl = await getSignedUrl(s3Result.key, 3600);

        return res.status(201).json({
            success: true,
            message: 'File uploaded successfully',
            data: {
                id: fileId,
                fileName: req.file.originalname,
                fileSize: req.file.size,
                url: signedUrl,
                uploadedAt: fileData.uploadedAt
            }
        });

    } catch (error) {
        console.error('File upload error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to upload file',
            message: error.message
        });
    }
});

// ============================================
// POST /api/files/upload-multiple - Upload multiple files
// ============================================
router.post('/upload-multiple', upload.array('files', 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No files uploaded'
            });
        }

        const { projectId, category } = req.body;

        if (!projectId) {
            return res.status(400).json({
                success: false,
                error: 'Project ID is required'
            });
        }

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
                error: 'Access denied'
            });
        }

        const uploadedFiles = [];
        const folder = `projects/${projectId}/${category || 'general'}`;

        for (const file of req.files) {
            try {
                const s3Result = await uploadFile(
                    file.buffer,
                    file.originalname,
                    file.mimetype,
                    folder
                );

                const fileId = generateId();
                const fileData = {
                    id: fileId,
                    projectId: projectId,
                    projectName: project.projectName,
                    projectCode: project.projectCode,
                    fileName: file.originalname,
                    fileSize: file.size,
                    mimeType: file.mimetype,
                    category: category || 'general',
                    s3Key: s3Result.key,
                    s3Bucket: s3Result.bucket,
                    uploadedBy: req.user.name,
                    uploadedByUid: req.user.uid,
                    uploadedAt: timestamp(),
                    isDeleted: false
                };

                await putItem(process.env.FILES_TABLE, fileData);

                const signedUrl = await getSignedUrl(s3Result.key, 3600);

                uploadedFiles.push({
                    id: fileId,
                    fileName: file.originalname,
                    fileSize: file.size,
                    url: signedUrl
                });

            } catch (fileError) {
                console.error(`Error uploading ${file.originalname}:`, fileError);
                uploadedFiles.push({
                    fileName: file.originalname,
                    error: 'Upload failed'
                });
            }
        }

        return res.status(201).json({
            success: true,
            message: `${uploadedFiles.length} files processed`,
            data: uploadedFiles
        });

    } catch (error) {
        console.error('Multiple file upload error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to upload files',
            message: error.message
        });
    }
});

// ============================================
// GET /api/files - List files
// ============================================
router.get('/', async (req, res) => {
    try {
        const { projectId, category, id } = req.query;

        // Get single file
        if (id) {
            const file = await getItem(process.env.FILES_TABLE, { id });
            
            if (!file || file.isDeleted) {
                return res.status(404).json({
                    success: false,
                    error: 'File not found'
                });
            }

            // Check permissions
            const project = await getItem(process.env.PROJECTS_TABLE, { id: file.projectId });
            if (project) {
                const hasAccess = 
                    req.user.role === 'coo' || 
                    req.user.role === 'director' ||
                    project.designLeadUid === req.user.uid ||
                    (project.assignedDesignerUids || []).includes(req.user.uid);

                if (!hasAccess) {
                    return res.status(403).json({
                        success: false,
                        error: 'Access denied'
                    });
                }
            }

            const signedUrl = await getSignedUrl(file.s3Key, 3600);

            return res.status(200).json({
                success: true,
                data: {
                    ...file,
                    url: signedUrl
                }
            });
        }

        // List files
        let files = [];

        if (projectId) {
            files = await queryByIndex(
                process.env.FILES_TABLE,
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
                    project.designLeadUid === req.user.uid ||
                    (project.assignedDesignerUids || []).includes(req.user.uid);

                if (!hasAccess) {
                    return res.status(403).json({
                        success: false,
                        error: 'Access denied'
                    });
                }
            }
        } else {
            if (!['coo', 'director'].includes(req.user.role)) {
                return res.status(403).json({
                    success: false,
                    error: 'Insufficient permissions'
                });
            }
            files = await scanTable(process.env.FILES_TABLE);
        }

        // Filter
        files = files.filter(f => !f.isDeleted);
        if (category) {
            files = files.filter(f => f.category === category);
        }

        // Sort by upload date
        files.sort((a, b) => b.uploadedAt - a.uploadedAt);

        // Generate signed URLs
        const filesWithUrls = await Promise.all(
            files.map(async (file) => {
                const signedUrl = await getSignedUrl(file.s3Key, 3600);
                return {
                    id: file.id,
                    fileName: file.fileName,
                    fileSize: file.fileSize,
                    mimeType: file.mimeType,
                    category: file.category,
                    projectId: file.projectId,
                    uploadedBy: file.uploadedBy,
                    uploadedAt: file.uploadedAt,
                    url: signedUrl
                };
            })
        );

        return res.status(200).json({
            success: true,
            data: filesWithUrls,
            count: filesWithUrls.length
        });

    } catch (error) {
        console.error('List files error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to list files',
            message: error.message
        });
    }
});

// ============================================
// GET /api/files/:id/download - Get download URL
// ============================================
router.get('/:id/download', async (req, res) => {
    try {
        const { id } = req.params;
        const { expiresIn = 3600 } = req.query;

        const file = await getItem(process.env.FILES_TABLE, { id });

        if (!file || file.isDeleted) {
            return res.status(404).json({
                success: false,
                error: 'File not found'
            });
        }

        // Check permissions
        const project = await getItem(process.env.PROJECTS_TABLE, { id: file.projectId });
        if (project) {
            const hasAccess = 
                req.user.role === 'coo' || 
                req.user.role === 'director' ||
                project.designLeadUid === req.user.uid ||
                (project.assignedDesignerUids || []).includes(req.user.uid);

            if (!hasAccess) {
                return res.status(403).json({
                    success: false,
                    error: 'Access denied'
                });
            }
        }

        const downloadUrl = await getSignedUrl(file.s3Key, parseInt(expiresIn));

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'file_downloaded',
            details: `File "${file.fileName}" downloaded by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: file.projectId,
            fileId: id
        });

        return res.status(200).json({
            success: true,
            data: {
                fileName: file.fileName,
                url: downloadUrl,
                expiresIn: parseInt(expiresIn)
            }
        });

    } catch (error) {
        console.error('File download error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to get download URL',
            message: error.message
        });
    }
});

// ============================================
// DELETE /api/files/:id - Delete file
// ============================================
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const file = await getItem(process.env.FILES_TABLE, { id });

        if (!file || file.isDeleted) {
            return res.status(404).json({
                success: false,
                error: 'File not found'
            });
        }

        // Check permissions
        const canDelete = 
            req.user.role === 'coo' ||
            req.user.role === 'director' ||
            file.uploadedByUid === req.user.uid;

        if (!canDelete) {
            return res.status(403).json({
                success: false,
                error: 'Access denied'
            });
        }

        // Delete from S3
        await deleteFile(file.s3Key);

        // Mark as deleted in DynamoDB
        await updateItem(
            process.env.FILES_TABLE,
            { id },
            {
                isDeleted: true,
                deletedAt: timestamp(),
                deletedBy: req.user.name
            }
        );

        // Log activity
        await putItem(process.env.ACTIVITIES_TABLE, {
            id: generateId(),
            type: 'file_deleted',
            details: `File "${file.fileName}" deleted by ${req.user.name}`,
            performedByName: req.user.name,
            performedByRole: req.user.role,
            performedByUid: req.user.uid,
            timestamp: timestamp(),
            projectId: file.projectId,
            fileId: id
        });

        return res.status(200).json({
            success: true,
            message: 'File deleted successfully'
        });

    } catch (error) {
        console.error('Delete file error:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to delete file',
            message: error.message
        });
    }
});

module.exports = router;
