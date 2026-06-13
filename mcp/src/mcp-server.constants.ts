/**
 * The MCP server name. Must be identical between `McpModule.forRoot({ name })`
 * (app.module) and every `McpModule.forFeature([...], MCP_SERVER_NAME)` in the
 * tool modules — @rekog/mcp-nest maps forFeature registrations to the forRoot
 * server by this exact string. A mismatch silently drops the tools (the server
 * boots, advertises empty capabilities, and every agent run fails with
 * "no callable tools").
 */
export const MCP_SERVER_NAME = 'orchesight-mcp';
