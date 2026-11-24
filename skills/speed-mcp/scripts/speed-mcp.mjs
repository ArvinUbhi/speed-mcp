#!/usr/bin/env node
// This path remains valid when the entire plugin is installed or moved.
import { main, reportError } from '../../../dist/speed-mcp.mjs';
await main().catch(reportError);
