'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolves the absolute path to the WhatsApp Web session directory.
 */
function getSessionDir(dataPath = './.wwebjs_auth', clientId = null) {
    const base = path.resolve(dataPath);
    const sessionDirName = clientId ? `session-${clientId}` : 'session';
    return path.join(base, sessionDirName);
}

/**
 * Removes Chrome singleton lock files from the session directory.
 * Note: fs.existsSync returns false for broken symlinks, so we use
 * fs.lstatSync or direct fs.unlinkSync.
 */
function removeSessionLocks(sessionDir) {
    if (!fs.existsSync(sessionDir)) return;

    const lockFiles = [
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket',
        'DevToolsActivePort',
        'lockfile',
    ];

    for (const file of lockFiles) {
        const filePath = path.join(sessionDir, file);
        try {
            fs.lstatSync(filePath);
            fs.unlinkSync(filePath);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                try {
                    fs.rmSync(filePath, { force: true });
                } catch (_) { /* ignore */ }
            }
        }
    }
}

/**
 * Finds PIDs of any browser processes associated with the session directory.
 */
function findSessionPids(sessionDir) {
    const pids = new Set();
    const normalizedDir = path.resolve(sessionDir);

    // 1. Check SingletonLock symlink target if present
    const singletonLock = path.join(sessionDir, 'SingletonLock');
    try {
        const stat = fs.lstatSync(singletonLock);
        if (stat.isSymbolicLink()) {
            const target = fs.readlinkSync(singletonLock);
            const match = target.match(/-(\d+)$/);
            if (match) {
                const pid = parseInt(match[1], 10);
                if (pid && pid !== process.pid) {
                    try {
                        process.kill(pid, 0); // Check if process is alive
                        pids.add(pid);
                    } catch (_) { /* process not running */ }
                }
            }
        }
    } catch (_) { /* ignore */ }

    // 2. On Linux, inspect /proc to find any Chrome processes attached to this session
    if (process.platform === 'linux' && fs.existsSync('/proc')) {
        try {
            const entries = fs.readdirSync('/proc');
            for (const entry of entries) {
                if (!/^\d+$/.test(entry)) continue;
                const pid = parseInt(entry, 10);
                if (pid === process.pid) continue;

                try {
                    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
                    const isSessionChrome =
                        (cmdline.includes('--user-data-dir=') && (cmdline.includes(normalizedDir) || cmdline.includes('.wwebjs_auth/session'))) ||
                        (cmdline.includes('chrome') && cmdline.includes(normalizedDir));

                    if (isSessionChrome) {
                        pids.add(pid);
                    }
                } catch (_) {
                    // EACCES or process ended
                }
            }
        } catch (_) { /* ignore */ }
    }

    return Array.from(pids);
}

/**
 * Terminates a process, starting with SIGTERM and falling back to SIGKILL.
 */
function killProcessTree(pid) {
    if (!pid || pid === process.pid) return;

    try {
        process.kill(pid, 0);
    } catch (_) {
        return; // Already dead
    }

    try {
        process.kill(pid, 'SIGTERM');
    } catch (_) { /* ignore */ }

    // Give the process up to 300ms to terminate gracefully
    const start = Date.now();
    while (Date.now() - start < 300) {
        try {
            process.kill(pid, 0);
        } catch (_) {
            return; // Terminated cleanly
        }
    }

    // Force terminate if still alive
    try {
        process.kill(pid, 'SIGKILL');
    } catch (_) { /* ignore */ }
}

/**
 * Terminates all orphaned browser processes associated with the session.
 */
function cleanupSessionProcesses(sessionDir) {
    const pids = findSessionPids(sessionDir);
    for (const pid of pids) {
        try {
            killProcessTree(pid);
        } catch (_) { /* ignore */ }
    }
    return pids.length;
}

/**
 * Prepares the session by terminating any lingering browser processes
 * and removing stale lock files.
 */
function prepareSession(sessionDir) {
    const killedCount = cleanupSessionProcesses(sessionDir);
    removeSessionLocks(sessionDir);
    return killedCount;
}

/**
 * Sets up graceful shutdown hooks for SIGINT, SIGTERM, and SIGHUP.
 */
function setupGracefulShutdown({ client, sessionDir, onShutdown }) {
    let isShuttingDown = false;

    async function handleExit(signal = 'SIGINT') {
        if (isShuttingDown) {
            console.log('\n⚠️  Forced exit requested. Terminating immediately…');
            try {
                cleanupSessionProcesses(sessionDir);
                removeSessionLocks(sessionDir);
            } catch (_) { /* ignore */ }
            process.exit(1);
        }

        isShuttingDown = true;
        console.log(`\n👋 Shutting down gracefully (${signal})…`);

        // Hard timeout safety net: force exit if shutdown takes longer than 3.5s
        const hardTimeout = setTimeout(() => {
            console.warn('⚠️  Shutdown timed out. Forcing exit…');
            try {
                cleanupSessionProcesses(sessionDir);
                removeSessionLocks(sessionDir);
            } catch (_) { /* ignore */ }
            process.exit(1);
        }, 3500);
        hardTimeout.unref();

        // 1. App-specific shutdown callback (e.g. stop scheduler)
        try {
            if (typeof onShutdown === 'function') {
                await onShutdown();
            }
        } catch (err) {
            console.error('⚠️  [Shutdown] Error in onShutdown hook:', err.message);
        }

        // 2. Client & browser shutdown
        try {
            if (client) {
                const browser = client.pupBrowser;
                const childProc = browser && typeof browser.process === 'function' ? browser.process() : null;

                // Race client.destroy with a 2-second timeout
                await Promise.race([
                    client.destroy().catch(() => {}),
                    new Promise((resolve) => setTimeout(resolve, 2000)),
                ]);

                // Ensure child process is killed if still alive
                if (childProc && childProc.pid) {
                    try {
                        process.kill(childProc.pid, 0);
                        childProc.kill('SIGKILL');
                    } catch (_) { /* ignore */ }
                }
            }
        } catch (_) {
            // Ignore client destruction errors on exit
        }

        // 3. Final sweep of any lingering session processes or lock files
        try {
            cleanupSessionProcesses(sessionDir);
            removeSessionLocks(sessionDir);
        } catch (_) { /* ignore */ }

        clearTimeout(hardTimeout);
        process.exit(0);
    }

    process.on('SIGINT', () => handleExit('SIGINT'));
    process.on('SIGTERM', () => handleExit('SIGTERM'));
    process.on('SIGHUP', () => handleExit('SIGHUP'));

    return {
        handleExit,
        isShuttingDown: () => isShuttingDown,
    };
}

module.exports = {
    getSessionDir,
    removeSessionLocks,
    findSessionPids,
    cleanupSessionProcesses,
    prepareSession,
    setupGracefulShutdown,
};
