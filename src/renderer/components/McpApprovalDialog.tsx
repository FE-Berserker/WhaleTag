import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  Typography,
} from '@mui/material';
import GppMaybeIcon from '@mui/icons-material/GppMaybe';

import { ipcApi } from '-/services/ipc-api';
import type { McpApprovalRequest } from '../../shared/mcp-types';

/**
 * Write-operation approval for the local MCP server (docs/21). When an
 * external AI client calls a mutating tool (move / copy / delete / zip /
 * create), main pushes `mcp:approvalRequest` and blocks the tool call until
 * the user answers here. Fail-closed: timeout / no dialog / deny all count
 * as denial on the main side, so this component only ever sends explicit
 * answers.
 *
 * Mounted once in MainLayout. On mount it also pulls the pending queue so a
 * window reload mid-approval can still answer (requests auto-deny after 60s).
 */
export default function McpApprovalDialog() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<McpApprovalRequest[]>([]);

  useEffect(() => {
    const unsubscribe = ipcApi.onMcpApprovalRequest((req) => {
      setRequests((prev) =>
        prev.some((r) => r.reqId === req.reqId) ? prev : [...prev, req]
      );
    });
    // Adopt any requests that were already pending before this mount.
    void ipcApi
      .mcpPendingApprovals()
      .then((pending) => {
        setRequests((prev) => {
          const seen = new Set(prev.map((r) => r.reqId));
          return [...prev, ...pending.filter((r) => !seen.has(r.reqId))];
        });
      })
      .catch(() => undefined);
    return unsubscribe;
  }, []);

  // Drop requests whose expiry passed without a user answer (main auto-denied
  // them) so the dialog can't show a zombie entry.
  useEffect(() => {
    if (requests.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setRequests((prev) => prev.filter((r) => r.expiresAt > now));
    }, 1000);
    return () => clearInterval(timer);
  }, [requests.length]);

  if (requests.length === 0) return null;
  // Oldest request first — a younger push must not jump the queue while an
  // older one is ticking toward its auto-deny.
  const req = [...requests].sort((a, b) => a.expiresAt - b.expiresAt)[0];

  const answer = (allowed: boolean) => {
    setRequests((prev) => prev.filter((r) => r.reqId !== req.reqId));
    void ipcApi
      .mcpResolveApproval(req.reqId, allowed)
      .catch(() => undefined);
  };

  return (
    <Dialog open maxWidth="sm" fullWidth>
      <DialogContent sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
        <GppMaybeIcon color="warning" sx={{ mt: 0.5 }} />
        <div>
          <Typography variant="subtitle1" component="div">
            {t('mcpApproveTitle')}
          </Typography>
          <DialogContentText sx={{ mt: 1 }}>
            {t('mcpApproveIntro', { tool: req.tool })}
          </DialogContentText>
          <Typography variant="body2" sx={{ mt: 1.5, fontWeight: 600 }}>
            {req.summary}
          </Typography>
          {req.details.length > 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              component="div"
              sx={{
                mt: 0.5,
                fontFamily: 'monospace',
                fontSize: 12,
                wordBreak: 'break-all',
                whiteSpace: 'pre-wrap',
                maxHeight: 220,
                overflowY: 'auto',
              }}
            >
              {req.details.join('\n')}
            </Typography>
          ) : null}
        </div>
      </DialogContent>
      <DialogActions>
        {/* autoFocus on Deny: a fast Enter must never mean "allow" — batch
            destructive operations deserve a deliberate confirmation. */}
        <Button onClick={() => answer(false)} color="inherit" autoFocus>
          {t('mcpApproveDeny')}
        </Button>
        <Button onClick={() => answer(true)} variant="contained" color="primary">
          {t('mcpApproveAllow')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
