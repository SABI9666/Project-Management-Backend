// src/middleware/auth.js
const { verifyToken } = require('../utils/cognito');

// This is the authentication middleware your routes are trying to use
const authenticate = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized'
            });
        }
        
        const token = authHeader.split(' ')[1];
        const decoded = verifyToken(token);
        
        if (!decoded) {
            return res.status(401).json({
                success: false,
                error: 'Invalid or expired token'
            });
        }
        
        // Attach user info to the request object
        req.user = decoded;
        next();
        
    } catch (error) {
        return res.status(401).json({
            success: false,
            error: 'Authentication failed'
        });
    }
};

module.exports = {
    verifyToken: authenticate // Export the middleware
};
