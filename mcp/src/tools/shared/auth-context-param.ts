import { z } from 'zod';

/**
 * The `authContext` parameter every tool accepts (dynamic org binding —
 * see requireOrganizationId in security/agent-context.ts). Declared once
 * so the wording the LLM sees is identical on every tool.
 *
 * The value is a signed JWT minted by os-investigation for the user who
 * started the chat/procedure. The agent can only relay it — any
 * modification breaks the signature and the call is rejected.
 */
export const authContextParam = z
  .string()
  .optional()
  .describe(
    'signed user context token — required in multi-tenant deployments; ' +
      'pass it verbatim from your session context',
  );
