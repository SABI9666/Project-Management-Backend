// src/api/email.js - Email API Routes
const express = require('express');
const router = express.Router();
const AWS = require('aws-sdk');

// Configure AWS SES
const ses = new AWS.SES({
    region: process.env.SES_REGION || process.env.REGION || 'ap-south-1'
});

// ==========================================================
// SEND EMAIL FUNCTION
// ==========================================================
const sendEmail = async (to, subject, htmlBody, textBody) => {
    try {
        const params = {
            Source: process.env.SES_FROM_EMAIL || 'noreply@pmtracker.com',
            Destination: {
                ToAddresses: [to]
            },
            Message: {
                Subject: {
                    Data: subject,
                    Charset: 'UTF-8'
                },
                Body: {
                    Html: {
                        Data: htmlBody,
                        Charset: 'UTF-8'
                    },
                    Text: {
                        Data: textBody || htmlBody.replace(/<[^>]*>/g, ''),
                        Charset: 'UTF-8'
                    }
                }
            }
        };

        const result = await ses.sendEmail(params).promise();
        console.log('✅ Email sent successfully:', result.MessageId);
        return {
            success: true,
            messageId: result.MessageId
        };
    } catch (error) {
        console.error('❌ Error sending email:', error);
        
        // Handle common SES errors gracefully
        if (error.code === 'MessageRejected') {
            console.warn('⚠️ Email address not verified in SES. Email not sent.');
            // Don't throw error - just log it
            return {
                success: false,
                error: 'Email not verified in SES',
                skipped: true
            };
        }
        
        throw error;
    }
};

// ==========================================================
// SEND WELCOME EMAIL
// ==========================================================
const sendWelcomeEmail = async (email, name, role) => {
    const subject = 'Welcome to EDANBROOK Project Management Platform';
    
    const htmlBody = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
                .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; margin-top: 30px; font-size: 12px; color: #666; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Welcome to EDANBROOK</h1>
                </div>
                <div class="content">
                    <h2>Hello ${name}!</h2>
                    <p>Your account has been successfully created for the EDANBROOK Project Management Platform.</p>
                    
                    <h3>Account Details:</h3>
                    <ul>
                        <li><strong>Email:</strong> ${email}</li>
                        <li><strong>Role:</strong> ${role.toUpperCase()}</li>
                    </ul>
                    
                    <p>You can now login to your account and start managing projects.</p>
                    
                    <a href="${process.env.FRONTEND_URL || 'https://ebtracker.vercel.app'}/login" class="button">
                        Login to Your Account
                    </a>
                    
                    <h3>Getting Started:</h3>
                    <ul>
                        <li>Complete your profile information</li>
                        <li>Explore the dashboard</li>
                        <li>Start managing your projects</li>
                    </ul>
                    
                    <p>If you have any questions, please don't hesitate to reach out to our support team.</p>
                </div>
                <div class="footer">
                    <p>&copy; 2025 EDANBROOK. All rights reserved.</p>
                    <p>This is an automated message, please do not reply to this email.</p>
                </div>
            </div>
        </body>
        </html>
    `;
    
    const textBody = `
        Welcome to EDANBROOK, ${name}!
        
        Your account has been successfully created.
        
        Account Details:
        - Email: ${email}
        - Role: ${role.toUpperCase()}
        
        Login at: ${process.env.FRONTEND_URL || 'https://ebtracker.vercel.app'}/login
        
        © 2025 EDANBROOK. All rights reserved.
    `;
    
    return sendEmail(email, subject, htmlBody, textBody);
};

// ==========================================================
// SEND PASSWORD RESET EMAIL
// ==========================================================
const sendPasswordResetEmail = async (email, name, resetToken) => {
    const resetUrl = `${process.env.FRONTEND_URL || 'https://ebtracker.vercel.app'}/reset-password?token=${resetToken}`;
    const subject = 'Password Reset Request';
    
    const htmlBody = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #667eea; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
                .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Password Reset Request</h1>
                </div>
                <div class="content">
                    <h2>Hello ${name},</h2>
                    <p>We received a request to reset your password for your EDANBROOK account.</p>
                    
                    <p>Click the button below to reset your password:</p>
                    
                    <a href="${resetUrl}" class="button">Reset Password</a>
                    
                    <div class="warning">
                        <strong>⚠️ Security Notice:</strong>
                        <p>This link will expire in 1 hour. If you didn't request this password reset, please ignore this email.</p>
                    </div>
                    
                    <p>Or copy and paste this link into your browser:</p>
                    <p style="word-break: break-all; color: #667eea;">${resetUrl}</p>
                </div>
            </div>
        </body>
        </html>
    `;
    
    const textBody = `
        Password Reset Request
        
        Hello ${name},
        
        We received a request to reset your password.
        
        Reset your password by clicking this link: ${resetUrl}
        
        This link will expire in 1 hour.
        
        If you didn't request this, please ignore this email.
    `;
    
    return sendEmail(email, subject, htmlBody, textBody);
};

// ==========================================================
// SEND NOTIFICATION EMAIL
// ==========================================================
const sendNotificationEmail = async (email, name, subject, message) => {
    const htmlBody = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #667eea; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>EDANBROOK Notification</h1>
                </div>
                <div class="content">
                    <h2>Hello ${name},</h2>
                    <p>${message}</p>
                </div>
            </div>
        </body>
        </html>
    `;
    
    return sendEmail(email, subject, htmlBody, message);
};

// ==========================================================
// API ROUTES
// ==========================================================

// POST /api/email/send - Send custom email
router.post('/send', async (req, res) => {
    try {
        const { to, subject, htmlBody, textBody } = req.body;
        
        if (!to || !subject || !htmlBody) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: to, subject, htmlBody'
            });
        }
        
        const result = await sendEmail(to, subject, htmlBody, textBody);
        
        res.status(200).json({
            success: true,
            message: 'Email sent successfully',
            messageId: result.messageId
        });
    } catch (error) {
        console.error('Error in send email route:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send email',
            error: error.message
        });
    }
});

// POST /api/email/welcome - Send welcome email
router.post('/welcome', async (req, res) => {
    try {
        const { email, name, role } = req.body;
        
        if (!email || !name || !role) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: email, name, role'
            });
        }
        
        const result = await sendWelcomeEmail(email, name, role);
        
        res.status(200).json({
            success: true,
            message: 'Welcome email sent successfully',
            messageId: result.messageId
        });
    } catch (error) {
        console.error('Error in welcome email route:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send welcome email',
            error: error.message
        });
    }
});

// POST /api/email/reset-password - Send password reset email
router.post('/reset-password', async (req, res) => {
    try {
        const { email, name, resetToken } = req.body;
        
        if (!email || !name || !resetToken) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: email, name, resetToken'
            });
        }
        
        const result = await sendPasswordResetEmail(email, name, resetToken);
        
        res.status(200).json({
            success: true,
            message: 'Password reset email sent successfully',
            messageId: result.messageId
        });
    } catch (error) {
        console.error('Error in reset password email route:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send password reset email',
            error: error.message
        });
    }
});

// POST /api/email/notification - Send notification email
router.post('/notification', async (req, res) => {
    try {
        const { email, name, subject, message } = req.body;
        
        if (!email || !name || !subject || !message) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: email, name, subject, message'
            });
        }
        
        const result = await sendNotificationEmail(email, name, subject, message);
        
        res.status(200).json({
            success: true,
            message: 'Notification email sent successfully',
            messageId: result.messageId
        });
    } catch (error) {
        console.error('Error in notification email route:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send notification email',
            error: error.message
        });
    }
});

// ==========================================================
// EXPORT ROUTER AND FUNCTIONS
// ==========================================================
module.exports = router;
module.exports.sendEmail = sendEmail;
module.exports.sendWelcomeEmail = sendWelcomeEmail;
module.exports.sendPasswordResetEmail = sendPasswordResetEmail;
module.exports.sendNotificationEmail = sendNotificationEmail;
