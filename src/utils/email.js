// src/utils/email.js - Email Service using AWS SES
const AWS = require('aws-sdk');

// Configure AWS SES
const ses = new AWS.SES({
    region: process.env.REGION || 'ap-south-1',
    apiVersion: '2010-12-01'
});

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@ebtracker.com';
const FROM_NAME = process.env.FROM_NAME || 'EBTracker System';

// Send email using AWS SES
const sendEmail = async ({ to, subject, html, text }) => {
    try {
        if (!process.env.FROM_EMAIL) {
            console.warn('⚠️ FROM_EMAIL not configured, email not sent');
            return { success: false, message: 'Email service not configured' };
        }

        // Ensure 'to' is an array
        const recipients = Array.isArray(to) ? to : [to];

        const params = {
            Source: `${FROM_NAME} <${FROM_EMAIL}>`,
            Destination: {
                ToAddresses: recipients
            },
            Message: {
                Subject: {
                    Data: subject,
                    Charset: 'UTF-8'
                },
                Body: {
                    Html: {
                        Data: html,
                        Charset: 'UTF-8'
                    },
                    Text: {
                        Data: text || stripHtml(html),
                        Charset: 'UTF-8'
                    }
                }
            }
        };

        const result = await ses.sendEmail(params).promise();
        
        console.log('✅ Email sent via SES:', result.MessageId);
        return { success: true, messageId: result.MessageId };
    } catch (error) {
        console.error('❌ SES email send error:', error);
        return { success: false, error: error.message };
    }
};

// Send bulk email (up to 50 recipients)
const sendBulkEmail = async ({ recipients, subject, html, text }) => {
    try {
        if (recipients.length > 50) {
            throw new Error('AWS SES bulk email limited to 50 recipients at a time');
        }

        const destinations = recipients.map(email => ({
            Destination: {
                ToAddresses: [email]
            }
        }));

        const params = {
            Source: `${FROM_NAME} <${FROM_EMAIL}>`,
            DefaultContent: {
                Template: {
                    TemplateName: 'DefaultTemplate',
                    TemplateData: JSON.stringify({})
                }
            },
            Destinations: destinations,
            DefaultTemplateData: JSON.stringify({}),
            Template: {
                Subject: {
                    Data: subject,
                    Charset: 'UTF-8'
                },
                HtmlPart: {
                    Data: html,
                    Charset: 'UTF-8'
                },
                TextPart: {
                    Data: text || stripHtml(html),
                    Charset: 'UTF-8'
                }
            }
        };

        const result = await ses.sendBulkTemplatedEmail(params).promise();
        console.log('✅ Bulk email sent via SES');
        return { success: true, result };
    } catch (error) {
        console.error('❌ SES bulk email error:', error);
        return { success: false, error: error.message };
    }
};

// Strip HTML tags for plain text fallback
const stripHtml = (html) => {
    return html
        .replace(/<style[^>]*>.*<\/style>/gm, '')
        .replace(/<script[^>]*>.*<\/script>/gm, '')
        .replace(/<[^>]+>/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
};

// Email templates with improved styling
const templates = {
    // Base email wrapper
    emailWrapper: (content) => `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #2563eb; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background-color: #ffffff; padding: 30px; border: 1px solid #e5e7eb; }
                .footer { background-color: #f3f4f6; padding: 20px; text-align: center; font-size: 12px; color: #6b7280; border-radius: 0 0 8px 8px; }
                .button { display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px; margin: 10px 0; }
                .info-box { background-color: #f0f9ff; border-left: 4px solid #2563eb; padding: 15px; margin: 15px 0; }
                .warning-box { background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 15px 0; }
                .success-box { background-color: #d1fae5; border-left: 4px solid #10b981; padding: 15px; margin: 15px 0; }
                h2 { color: #1f2937; margin-top: 0; }
                .detail-row { margin: 10px 0; }
                .detail-label { font-weight: bold; color: #4b5563; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="margin: 0;">EBTracker</h1>
                    <p style="margin: 5px 0 0 0;">Project Management System</p>
                </div>
                <div class="content">
                    ${content}
                </div>
                <div class="footer">
                    <p>© ${new Date().getFullYear()} EBTracker by EDANBROOK. All rights reserved.</p>
                    <p>This is an automated email. Please do not reply.</p>
                </div>
            </div>
        </body>
        </html>
    `,

    proposalSubmitted: (data) => ({
        subject: `New Proposal Submitted: ${data.projectName}`,
        html: templates.emailWrapper(`
            <h2>New Proposal Submitted</h2>
            <div class="info-box">
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Client:</span> ${data.clientCompany}</div>
                <div class="detail-row"><span class="detail-label">Estimated Value:</span> ${data.currency || 'USD'} ${data.estimatedValue}</div>
                <div class="detail-row"><span class="detail-label">Submitted by:</span> ${data.submittedBy}</div>
                <div class="detail-row"><span class="detail-label">Status:</span> Pending Review</div>
            </div>
            <p>Please review this proposal in the EBTracker system.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">Review Proposal</a>` : ''}
        `)
    }),

    proposalApproved: (data) => ({
        subject: `Proposal Approved: ${data.projectName}`,
        html: templates.emailWrapper(`
            <h2>✅ Proposal Approved</h2>
            <div class="success-box">
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Client:</span> ${data.clientCompany}</div>
                <div class="detail-row"><span class="detail-label">Approved by:</span> ${data.approvedBy}</div>
                ${data.notes ? `<div class="detail-row"><span class="detail-label">Notes:</span> ${data.notes}</div>` : ''}
            </div>
            <p>Congratulations! The proposal has been approved and is ready for project creation.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">View Details</a>` : ''}
        `)
    }),

    proposalRejected: (data) => ({
        subject: `Proposal Rejected: ${data.projectName}`,
        html: templates.emailWrapper(`
            <h2>❌ Proposal Rejected</h2>
            <div class="warning-box">
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Rejected by:</span> ${data.rejectedBy}</div>
                <div class="detail-row"><span class="detail-label">Reason:</span> ${data.reason || 'No reason provided'}</div>
            </div>
            <p>Please review the feedback and make necessary changes before resubmitting.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">View Feedback</a>` : ''}
        `)
    }),

    pricingCompleted: (data) => ({
        subject: `Pricing Completed: ${data.projectName}`,
        html: templates.emailWrapper(`
            <h2>💰 Pricing Completed</h2>
            <div class="info-box">
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Quote Value:</span> ${data.currency} ${data.quoteValue}</div>
                <div class="detail-row"><span class="detail-label">Completed by:</span> ${data.completedBy}</div>
            </div>
            <p>The pricing has been completed and is ready for COO approval.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">Review Pricing</a>` : ''}
        `)
    }),

    projectAllocated: (data) => ({
        subject: `Project Allocated: ${data.projectName}`,
        html: templates.emailWrapper(`
            <h2>🎯 New Project Allocated</h2>
            <div class="info-box">
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Project Code:</span> ${data.projectCode}</div>
                <div class="detail-row"><span class="detail-label">Client:</span> ${data.clientCompany}</div>
                <div class="detail-row"><span class="detail-label">Allocated Hours:</span> ${data.allocatedHours} hours</div>
                ${data.deadline ? `<div class="detail-row"><span class="detail-label">Deadline:</span> ${data.deadline}</div>` : ''}
            </div>
            <p>You have been allocated to this project. Please check the EBTracker system for complete details and requirements.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">View Project</a>` : ''}
        `)
    }),

    designerAssigned: (data) => ({
        subject: `Designer Assignment: ${data.projectName}`,
        html: templates.emailWrapper(`
            <h2>👨‍🎨 New Project Assignment</h2>
            <div class="info-box">
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Project Code:</span> ${data.projectCode}</div>
                <div class="detail-row"><span class="detail-label">Design Lead:</span> ${data.designLead}</div>
                ${data.allocatedHours ? `<div class="detail-row"><span class="detail-label">Your Hours:</span> ${data.allocatedHours} hours</div>` : ''}
            </div>
            <p>You have been assigned to this project. Please coordinate with the Design Lead for task details.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">View Assignment</a>` : ''}
        `)
    }),

    variationSubmitted: (data) => ({
        subject: `Variation Submitted: ${data.variationCode}`,
        html: templates.emailWrapper(`
            <h2>📝 New Variation Submitted</h2>
            <div class="info-box">
                <div class="detail-row"><span class="detail-label">Variation Code:</span> ${data.variationCode}</div>
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Estimated Hours:</span> ${data.estimatedHours} hours</div>
                <div class="detail-row"><span class="detail-label">Submitted by:</span> ${data.submittedBy}</div>
                ${data.scopeDescription ? `<div class="detail-row"><span class="detail-label">Scope:</span> ${data.scopeDescription}</div>` : ''}
            </div>
            <p>This variation requires approval. Please review in the EBTracker system.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">Review Variation</a>` : ''}
        `)
    }),

    variationApproved: (data) => ({
        subject: `Variation Approved: ${data.variationCode}`,
        html: templates.emailWrapper(`
            <h2>✅ Variation Approved</h2>
            <div class="success-box">
                <div class="detail-row"><span class="detail-label">Variation Code:</span> ${data.variationCode}</div>
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Approved Hours:</span> ${data.approvedHours} hours</div>
                <div class="detail-row"><span class="detail-label">Approved by:</span> ${data.approvedBy}</div>
                ${data.notes ? `<div class="detail-row"><span class="detail-label">Notes:</span> ${data.notes}</div>` : ''}
            </div>
            <p>The variation has been approved and the hours have been added to the project budget.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">View Project</a>` : ''}
        `)
    }),

    variationRejected: (data) => ({
        subject: `Variation Rejected: ${data.variationCode}`,
        html: templates.emailWrapper(`
            <h2>❌ Variation Rejected</h2>
            <div class="warning-box">
                <div class="detail-row"><span class="detail-label">Variation Code:</span> ${data.variationCode}</div>
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Rejected by:</span> ${data.rejectedBy}</div>
                <div class="detail-row"><span class="detail-label">Reason:</span> ${data.reason || 'No reason provided'}</div>
            </div>
            <p>Please review the feedback and revise the variation request if necessary.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">View Feedback</a>` : ''}
        `)
    }),

    paymentReceived: (data) => ({
        subject: `Payment Received: ${data.projectName}`,
        html: templates.emailWrapper(`
            <h2>💵 Payment Received</h2>
            <div class="success-box">
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Invoice No:</span> ${data.invoiceNo}</div>
                <div class="detail-row"><span class="detail-label">Amount:</span> ${data.currency} ${data.amount}</div>
                <div class="detail-row"><span class="detail-label">Payment Date:</span> ${data.paymentDate}</div>
                ${data.paymentMethod ? `<div class="detail-row"><span class="detail-label">Method:</span> ${data.paymentMethod}</div>` : ''}
            </div>
            <p>Payment has been received and recorded in the system.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">View Payment</a>` : ''}
        `)
    }),

    paymentOverdue: (data) => ({
        subject: `⚠️ Payment Overdue: ${data.projectName}`,
        html: templates.emailWrapper(`
            <h2 style="color: #dc2626;">⚠️ Payment Overdue Alert</h2>
            <div class="warning-box">
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Invoice No:</span> ${data.invoiceNo}</div>
                <div class="detail-row"><span class="detail-label">Amount Due:</span> ${data.currency} ${data.amountDue}</div>
                <div class="detail-row"><span class="detail-label">Days Overdue:</span> <strong style="color: #dc2626;">${data.daysOverdue} days</strong></div>
                <div class="detail-row"><span class="detail-label">Due Date:</span> ${data.dueDate}</div>
            </div>
            <p><strong style="color: #dc2626;">URGENT:</strong> This payment is significantly overdue. Please follow up with the client immediately.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button" style="background-color: #dc2626;">View Payment Details</a>` : ''}
        `)
    }),

    invoiceGenerated: (data) => ({
        subject: `Invoice Generated: ${data.invoiceNo}`,
        html: templates.emailWrapper(`
            <h2>🧾 Invoice Generated</h2>
            <div class="info-box">
                <div class="detail-row"><span class="detail-label">Invoice No:</span> ${data.invoiceNo}</div>
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Amount:</span> ${data.currency} ${data.amount}</div>
                <div class="detail-row"><span class="detail-label">Due Date:</span> ${data.dueDate}</div>
            </div>
            <p>A new invoice has been generated for this project.</p>
            ${data.invoiceUrl ? `<a href="${data.invoiceUrl}" class="button">Download Invoice</a>` : ''}
        `)
    }),

    userCreated: (data) => ({
        subject: 'Welcome to EBTracker',
        html: templates.emailWrapper(`
            <h2>Welcome to EBTracker!</h2>
            <p>Hello ${data.name},</p>
            <p>Your account has been successfully created. Here are your login details:</p>
            <div class="info-box">
                <div class="detail-row"><span class="detail-label">Email:</span> ${data.email}</div>
                <div class="detail-row"><span class="detail-label">Role:</span> ${data.role}</div>
                <div class="detail-row"><span class="detail-label">Temporary Password:</span> <code>${data.password}</code></div>
            </div>
            <div class="warning-box">
                <strong>Important:</strong> Please log in and change your password immediately for security purposes.
            </div>
            <p>You can access the EBTracker system using the button below:</p>
            <a href="${data.loginUrl || 'https://ebtracker.com/login'}" class="button">Log In to EBTracker</a>
            <p>If you have any questions, please contact your system administrator.</p>
        `)
    }),

    passwordReset: (data) => ({
        subject: 'Password Reset Request',
        html: templates.emailWrapper(`
            <h2>Password Reset Request</h2>
            <p>Hello ${data.name},</p>
            <p>We received a request to reset your password for your EBTracker account.</p>
            <div class="info-box">
                <div class="detail-row"><span class="detail-label">Email:</span> ${data.email}</div>
                <div class="detail-row"><span class="detail-label">Request Time:</span> ${new Date().toLocaleString()}</div>
            </div>
            <p>Click the button below to reset your password:</p>
            <a href="${data.resetUrl}" class="button">Reset Password</a>
            <p>This link will expire in ${data.expiryHours || 24} hours.</p>
            <div class="warning-box">
                <strong>Security Note:</strong> If you didn't request this password reset, please ignore this email and contact your administrator immediately.
            </div>
        `)
    }),

    timesheetReminder: (data) => ({
        subject: 'Timesheet Submission Reminder',
        html: templates.emailWrapper(`
            <h2>⏰ Timesheet Reminder</h2>
            <p>Hello ${data.name},</p>
            <p>This is a friendly reminder to submit your timesheet.</p>
            <div class="info-box">
                <div class="detail-row"><span class="detail-label">Period:</span> ${data.period}</div>
                <div class="detail-row"><span class="detail-label">Due Date:</span> ${data.dueDate}</div>
                ${data.pendingHours ? `<div class="detail-row"><span class="detail-label">Pending Hours:</span> ${data.pendingHours}</div>` : ''}
            </div>
            <p>Please submit your timesheet as soon as possible to avoid any delays.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">Submit Timesheet</a>` : ''}
        `)
    }),

    deliverableSubmitted: (data) => ({
        subject: `Deliverable Submitted: ${data.deliverableName}`,
        html: templates.emailWrapper(`
            <h2>📦 Deliverable Submitted</h2>
            <div class="info-box">
                <div class="detail-row"><span class="detail-label">Deliverable:</span> ${data.deliverableName}</div>
                <div class="detail-row"><span class="detail-label">Project:</span> ${data.projectName}</div>
                <div class="detail-row"><span class="detail-label">Submitted by:</span> ${data.submittedBy}</div>
                <div class="detail-row"><span class="detail-label">Submission Date:</span> ${data.submissionDate}</div>
                ${data.description ? `<div class="detail-row"><span class="detail-label">Description:</span> ${data.description}</div>` : ''}
            </div>
            <p>A new deliverable has been submitted and is ready for review.</p>
            ${data.loginUrl ? `<a href="${data.loginUrl}" class="button">Review Deliverable</a>` : ''}
        `)
    })
};

// Send notification using template
const sendNotificationEmail = async (recipients, templateName, data) => {
    try {
        if (!templates[templateName]) {
            console.error(`Email template '${templateName}' not found`);
            return { success: false, error: 'Template not found' };
        }

        const template = templates[templateName](data);

        return await sendEmail({
            to: recipients,
            subject: template.subject,
            html: template.html
        });
    } catch (error) {
        console.error('Error sending notification email:', error);
        return { success: false, error: error.message };
    }
};

// Verify SES email address (for new FROM_EMAIL addresses)
const verifySESEmail = async (email) => {
    try {
        const params = {
            EmailAddress: email
        };
        await ses.verifyEmailIdentity(params).promise();
        console.log(`✅ Verification email sent to: ${email}`);
        return { success: true, message: 'Verification email sent' };
    } catch (error) {
        console.error('❌ SES verification error:', error);
        return { success: false, error: error.message };
    }
};

// Check SES sending statistics
const getSESStatistics = async () => {
    try {
        const result = await ses.getSendStatistics().promise();
        return { success: true, statistics: result.SendDataPoints };
    } catch (error) {
        console.error('❌ Error getting SES statistics:', error);
        return { success: false, error: error.message };
    }
};

module.exports = {
    sendEmail,
    sendBulkEmail,
    sendNotificationEmail,
    verifySESEmail,
    getSESStatistics,
    templates
};
