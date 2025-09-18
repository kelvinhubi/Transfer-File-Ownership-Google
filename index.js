/**
 * Google Drive Ownership Transfer - Console Interface
 * Uses localhost:3000 for OAuth callbacks but console prompts for user interaction
 */
// Required modules
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
// Initialize Express app
const app = express();
const PORT = 3000;
// Load OAuth2 credentials
const credentials = JSON.parse(fs.readFileSync('credentials.json'));
const { client_id, client_secret } = credentials.web;
// OAuth2 settings
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email'
];
const TOKENS_DIR = path.join(__dirname, 'tokens');

if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR);

// Global readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Global state
let currentAuth = null;
let isWaitingForAuth = false;
let authResolve = null;
// Create OAuth2 client
function createOAuthClient() {
    return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}
// Get token file path for a given email
function tokenPathForEmail(email) {
    return path.join(TOKENS_DIR, `${email}.json`);
}
// Save tokens for a given email
function saveTokens(email, tokens) {
    fs.writeFileSync(tokenPathForEmail(email), JSON.stringify(tokens, null, 2));
}
// Load tokens for a given email
function loadTokens(email) {
    const p = tokenPathForEmail(email);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p));
}
// Get authenticated OAuth2 client for a given email
async function getAuthForEmail(email) {
    const tokens = loadTokens(email);
    if (!tokens) {
        console.log(`\n❌ No tokens found for ${email}. Please authorize first.`);
        return null;
    }
    const oAuth2Client = createOAuthClient();
    oAuth2Client.setCredentials(tokens);
    return oAuth2Client;
}

// Express routes for OAuth callback
app.get('/callback', async (req, res) => {
    const { code, error } = req.query;
    // Handle OAuth response
    // Handle OAuth response
    if (error) {
        console.log(`\n❌ OAuth error: ${error}`);
        res.send('<h3>❌ Authorization failed</h3><p>Check console for details. You can close this tab.</p>');
        if (authResolve) authResolve(false);
        return;
    }

    if (!code) {
        console.log('\n❌ No authorization code received');
        res.send('<h3>❌ Missing authorization code</h3><p>You can close this tab.</p>');
        if (authResolve) authResolve(false);
        return;
    }
    // Exchange code for tokens
    console.log('\n🔄 Exchanging code for tokens...');
    const oAuth2Client = createOAuthClient();
    try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        // Get user info
        const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
        const { data: userInfo } = await oauth2.userinfo.get();
        const email = userInfo.email;

        console.log(`✅ Successfully authorized: ${email}`);
        saveTokens(email, tokens);

        res.send(`
            <h3>✅ Authorization Successful!</h3>
            <p><strong>Account:</strong> ${email}</p>
            <p>You can close this tab and return to the console.</p>
        `);

        if (authResolve) authResolve(email);
    } catch (e) {
        console.error('\n❌ Token exchange failed:', e.message);
        res.send('<h3>❌ Token exchange failed</h3><p>Check console for details. You can close this tab.</p>');
        if (authResolve) authResolve(false);
    }
});

// Console functions
async function authorizeUser(userType = 'user') {
    return new Promise((resolve) => {
        const oAuth2Client = createOAuthClient();
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent'
        });
        // Prompt user to open URL
        console.log(`\n🔐 Authorization required for ${userType}`);
        console.log('📋 Please open this URL in your browser:');
        console.log(`\n${authUrl}\n`);
        console.log('After authorization, the browser will show a success message.');
        console.log('Return to this console to continue...\n');

        isWaitingForAuth = true;
        authResolve = resolve;
    });
}
//List files for a user
async function listUserFiles(email) {
    const auth = await getAuthForEmail(email);
    if (!auth) return;
    try {
        const drive = google.drive({ version: 'v3', auth });
        const response = await drive.files.list({
            pageSize: 10,
            fields: 'files(id,name,owners)',
            q: 'trashed=false'
        });
        // Get files
        const files = response.data.files;
        if (files.length === 0) {
            console.log('📁 No files found.');
            return;
        }
        // Display files
        console.log('\n📁 Your files:');
        files.forEach((file, index) => {
            const isOwner = file.owners && file.owners.some(owner => owner.emailAddress === email);
            console.log(`${index + 1}. ${file.name} (ID: ${file.id}) ${isOwner ? '[OWNER]' : '[SHARED]'}`);
        });
        console.log('');
    } catch (error) {
        console.error('❌ Error listing files:', error.message);
    }
}
// Check file permissions
async function checkFilePermissions(ownerEmail, fileId) {
    const auth = await getAuthForEmail(ownerEmail);
    if (!auth) return;

    try {
        const drive = google.drive({ version: 'v3', auth });
        const response = await drive.permissions.list({
            fileId,
            fields: 'permissions(id,emailAddress,role,pendingOwner,displayName)'
        });

        console.log('\n👥 File permissions:');
        response.data.permissions.forEach(perm => {
            const pending = perm.pendingOwner ? ' [PENDING OWNER]' : '';
            console.log(`  • ${perm.emailAddress || perm.displayName} - ${perm.role}${pending}`);
        });
        console.log('');

        return response.data.permissions;
    } catch (error) {
        console.error('❌ Error checking permissions:', error.message);
        return null;
    }
}
// Initiate ownership transfer
async function initiateTransfer(ownerEmail, fileId, newOwnerEmail) {
    const auth = await getAuthForEmail(ownerEmail);
    if (!auth) return false;

    try {
        const drive = google.drive({ version: 'v3', auth });

        // Check existing permissions
        const existing = await drive.permissions.list({
            fileId,
            fields: 'permissions(id,emailAddress,role,pendingOwner)'
        });

        let perm = existing.data.permissions.find(p => p.emailAddress === newOwnerEmail);

        if (perm && perm.pendingOwner) {
            console.log(`⚠️  Pending ownership request already exists for ${newOwnerEmail}`);
            return true;
        }

        if (!perm) {
            // Create permission with writer + pendingOwner true
            console.log('🔄 Creating ownership transfer request...');
            await drive.permissions.create({
                fileId,
                sendNotificationEmail: true,
                requestBody: {
                    type: 'user',
                    role: 'writer',
                    emailAddress: newOwnerEmail,
                    pendingOwner: true
                }
            });
        } else {
            // Update existing permission
            console.log('🔄 Updating existing permission for ownership transfer...');
            await drive.permissions.update({
                fileId,
                permissionId: perm.id,
                requestBody: { role: 'writer', pendingOwner: true }
            });
        }

        console.log(`✅ Ownership transfer initiated! Email sent to ${newOwnerEmail}`);
        return true;
    } catch (error) {
        console.error('❌ Transfer initiation failed:', error.message);
        return false;
    }
}
// Accept ownership transfer
async function acceptTransfer(newOwnerEmail, fileId) {
    const auth = await getAuthForEmail(newOwnerEmail);
    if (!auth) return false;

    try {
        const drive = google.drive({ version: 'v3', auth });

        const perms = await drive.permissions.list({
            fileId,
            fields: 'permissions(id,emailAddress,role,pendingOwner)'
        });

        const myPerm = perms.data.permissions.find(p => p.emailAddress === newOwnerEmail);

        if (!myPerm) {
            console.log('❌ No permission found. Ensure the current owner initiated the transfer first.');
            return false;
        }

        if (!myPerm.pendingOwner) {
            console.log('❌ No pending ownership request found.');
            return false;
        }

        console.log('🔄 Accepting ownership transfer...');
        await drive.permissions.update({
            fileId,
            permissionId: myPerm.id,
            transferOwnership: true,
            requestBody: { role: 'owner' }
        });

        console.log(`✅ Ownership transfer completed! You are now the owner of file ${fileId}`);
        return true;
    } catch (error) {
        console.error('❌ Transfer acceptance failed:', error.message);
        return false;
    }
}
// Console menu and interaction
function askQuestion(question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            resolve(answer.trim());
        });
    });
}
// Main menu
async function mainMenu() {
    console.log('\n' + '='.repeat(50));
    console.log('📁 GOOGLE DRIVE OWNERSHIP TRANSFER TOOL');
    console.log('='.repeat(50));
    console.log('1. Authorize account');
    console.log('2. List my files');
    console.log('3. Check file permissions');
    console.log('4. Initiate ownership transfer (current owner)');
    console.log('5. Exit');
    console.log('');

    const choice = await askQuestion('Select an option (1-5): ');

    switch (choice) {
        case '1':
            const email = await authorizeUser();
            if (email) {
                console.log(`✅ Authorization successful for ${email}`);
            }
            break;

        case '2':
            const userEmail = await askQuestion('Enter your email address: ');
            await listUserFiles(userEmail);
            break;

        case '3':
            const ownerEmail = await askQuestion('Enter file owner email: ');
            const fileId = await askQuestion('Enter file ID: ');
            await checkFilePermissions(ownerEmail, fileId);
            break;

        case '4':
            const currentOwner = await askQuestion('Enter current owner email: ');
            const fileToTransfer = await askQuestion('Enter file ID: ');
            const newOwner = await askQuestion('Enter new owner email: ');
            await initiateTransfer(currentOwner, fileToTransfer, newOwner);
            break;

        case '5':
            console.log('\n👋 Goodbye!');
            rl.close();
            process.exit(0);
            break;

        default:
            console.log('❌ Invalid option. Please try again.');
    }

    // Return to menu
    setTimeout(() => mainMenu(), 1000);
}

// Start the application
async function startApp() {
    // Start Express server for OAuth callbacks
    app.listen(PORT, () => {
        console.log(`🌐 OAuth server running on http://localhost:${PORT}`);
    });

    // Start console interface
    console.log('🚀 Starting Google Drive Ownership Transfer Tool...\n');
    mainMenu();
}

startApp();
