const mode = process.argv[2];
if (mode === 'timeout') setInterval(() => {}, 1000);
else if (mode === 'invalid') { process.stderr.write('private-auth-secret'); process.stdout.write('invalid-private-auth-secret'); }
else if (mode === 'oversize') process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
else if (mode === 'failure') { process.stderr.write('private-auth-secret'); process.exit(1); }
else process.stdout.write(JSON.stringify({ mcpServers: { fixture: { command: 'node', headers: { Authorization: 'private-auth-secret' } } } }));
