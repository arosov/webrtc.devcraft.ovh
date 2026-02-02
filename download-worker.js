const activeStreams = new Map();

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.pathname.includes('/stream-download/')) {
        const parts = url.pathname.split('/');
        const downloadIndex = parts.indexOf('stream-download');
        if (downloadIndex !== -1 && parts.length > downloadIndex + 1) {
            const uuid = parts[downloadIndex + 1];
            const streamData = activeStreams.get(uuid);

            if (streamData) {
                const { stream, filename, contentType, size } = streamData;
                
                const headers = new Headers({
                    'Content-Type': contentType || 'application/octet-stream',
                    'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
                    'Cache-Control': 'no-cache',
                    'X-Content-Type-Options': 'nosniff'
                });

                if (size) {
                    headers.append('Content-Length', size);
                }

                event.respondWith(new Response(stream, { headers }));
            }
        }
    }
});

function notifyClients(message) {
    self.clients.matchAll().then(clients => {
        clients.forEach(client => {
            client.postMessage(message);
        });
    });
}

self.addEventListener('message', (event) => {
    const { type, uuid, payload } = event.data;

    switch (type) {
        case 'REGISTER_STREAM': {
            const { filename, contentType, size } = payload;
            let controller;
            let startedSignalSent = false;
            let pendingPullResolver = null;
            
            const stream = new ReadableStream({
                start(c) {
                    controller = c;
                },
                pull(c) {
                    return new Promise((resolve) => {
                        const streamData = activeStreams.get(uuid);
                        if (streamData) {
                            streamData.pendingPullResolver = resolve;
                        }
                        
                        if (!startedSignalSent) {
                            startedSignalSent = true;
                            notifyClients({
                                type: 'STREAM_STARTED',
                                uuid: uuid
                            });
                        }
                        
                        notifyClients({
                            type: 'PULL_DATA',
                            uuid: uuid
                        });
                    });
                },
                cancel(reason) {
                    notifyClients({
                        type: 'STREAM_ABORTED',
                        uuid: uuid,
                        reason: reason ? reason.toString() : 'User cancelled'
                    });
                    activeStreams.delete(uuid);
                }
            });
            
            activeStreams.set(uuid, { stream, controller, filename, contentType, size, pendingPullResolver: null });
            break;
        }

        case 'PUSH_DATA': {
            const data = activeStreams.get(uuid);
            if (data && data.controller) {
                data.controller.enqueue(new Uint8Array(payload));
                if (data.pendingPullResolver) {
                    data.pendingPullResolver();
                    data.pendingPullResolver = null;
                }
            }
            break;
        }

        case 'CLOSE_STREAM': {
            const closeData = activeStreams.get(uuid);
            if (closeData && closeData.controller) {
                try {
                    closeData.controller.close();
                } catch (e) {
                    console.error('Error closing stream', e);
                }
            }
            activeStreams.delete(uuid);
            break;
        }

        case 'ABORT_STREAM': {
            const abortData = activeStreams.get(uuid);
            if (abortData && abortData.controller) {
                try {
                    abortData.controller.error(new Error('Stream aborted by application'));
                } catch (e) {
                    console.error('Error aborting stream', e);
                }
            }
            activeStreams.delete(uuid);
            break;
        }
    }
});