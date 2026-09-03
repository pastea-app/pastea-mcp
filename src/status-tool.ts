// The one tool the bridge answers itself, and the sentences it says.
//
// Every message describes a state and names the user's next step. None of
// them tells the model how to behave — that is a directory review criterion,
// and also just good manners for text a model reads.
export const STATUS_TOOL = {
  name: 'pastea_status',
  title: 'Pastea Status',
  description:
    'Reports whether Pastea is reachable and connected on this Mac, and what to do if it is not.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { title: 'Pastea Status', readOnlyHint: true, openWorldHint: false },
} as const;

export type DegradedReason =
  | 'unreachable'
  | 'pro_required'
  | 'pairing'
  | 'denied'
  | 'expired'
  | 'outdated'
  | 'error';

export type StatusReason = DegradedReason | 'connected';

export function messageFor(reason: StatusReason, detail?: string): string {
  switch (reason) {
    case 'connected':
      return 'Pastea is connected. The clipboard tools are available.';
    case 'unreachable':
      return (
        "Pastea isn't running on this Mac, or its MCP endpoint is turned off. " +
        'Open Pastea → Settings → MCP & AI Tools and turn on Enable MCP, then call pastea_status again.'
      );
    case 'pro_required':
      return `${detail ?? 'Pastea Pro is required for MCP access.'} Then call pastea_status again.`;
    case 'pairing':
      return (
        'Pastea is asking the user to allow this connection. Once they click Allow in the ' +
        'Pastea window, the clipboard tools become available — call pastea_status again to check.'
      );
    case 'denied':
      return (
        'The user declined this connection in Pastea. Calling pastea_status again will ask ' +
        'them once more, so only do that if they want to connect.'
      );
    case 'expired':
      return (
        'Pastea waited for an answer but nobody clicked Allow. Call pastea_status again to ask once more.'
      );
    case 'outdated':
      return (
        'This version of Pastea has no extension support. Update Pastea to 1.3 or later, ' +
        'then call pastea_status again.'
      );
    case 'error':
      return `Pastea could not be reached properly${detail ? ` (${detail})` : ''}. Call pastea_status again to retry.`;
  }
}
