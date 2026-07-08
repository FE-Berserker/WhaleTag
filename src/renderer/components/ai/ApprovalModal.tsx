import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import ShieldIcon from '@mui/icons-material/Shield';

import { ipcApi } from '-/services/ipc-api';
import type { AiApprovalRequest, ApprovalDecision } from '../../../shared/ai-types';

/**
 * Subscribes to AI tool-call approval requests and shows a modal for each. The
 * main process blocks the turn on `ai:resolveApproval`, so only one request is
 * ever pending (turns are serial). Rendered once inside `AiPanel`.
 */
export default function ApprovalModal() {
  const { t } = useTranslation();
  const [req, setReq] = useState<AiApprovalRequest | null>(null);
  // ExitPlanMode (plan mode) renders as a readable plan with Approve / Request
  // changes rather than the generic tool-call approval.
  const isExitPlan = req?.toolName === 'ExitPlanMode';

  useEffect(() => {
    const off = ipcApi.onAiApprovalRequest((r) => setReq(r));
    return off;
  }, []);

  const resolve = (decision: ApprovalDecision) => {
    if (!req) return;
    const id = req.reqId;
    setReq(null);
    void ipcApi.aiResolveApproval(id, decision);
  };

  return (
    <Dialog
      open={req !== null}
      onClose={() => resolve('deny')}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <ShieldIcon color="warning" />
        {req
          ? isExitPlan
            ? t('aiPlanTitle')
            : `${t('aiApproveTitle')} · ${req.toolName}`
          : t('aiApproveTitle')}
      </DialogTitle>
      <DialogContent>
        {req ? (
          <Stack spacing={1}>
            {isExitPlan ? null : (
              <Typography variant="body2">{req.description}</Typography>
            )}
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                p: 1,
                bgcolor: 'action.hover',
                borderRadius: 0.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 260,
                overflow: 'auto',
                ...(isExitPlan ? { fontFamily: 'body', color: 'text.primary' } : { fontFamily: 'monospace' }),
              }}
            >
              {isExitPlan
                ? (req.input.plan as string | undefined) ?? JSON.stringify(req.input, null, 2)
                : JSON.stringify(req.input, null, 2)}
            </Typography>
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={() => resolve('deny')}>
          {isExitPlan ? t('aiPlanChanges') : t('aiDeny')}
        </Button>
        {isExitPlan ? null : (
          <Button onClick={() => resolve('allow-always')}>
            {t('aiAllowAlways')}
          </Button>
        )}
        <Button variant="contained" onClick={() => resolve('allow')}>
          {isExitPlan ? t('aiPlanApprove') : t('aiAllow')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
