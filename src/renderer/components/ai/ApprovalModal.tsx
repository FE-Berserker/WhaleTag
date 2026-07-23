import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ShieldIcon from '@mui/icons-material/Shield';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';

import { ipcApi } from '-/services/ipc-api';
import {
  parseAskUserQuestions,
  type AiApprovalRequest,
  type ApprovalDecision,
  type AskUserAnswers,
} from '../../../shared/ai-types';
import AskUserQuestionForm from './AskUserQuestionForm';
import {
  buildAskUserAnswers,
  emptyAskUserSelections,
  type AskUserSelection,
} from './askUserAnswers';

/**
 * Subscribes to AI tool-call approval requests and shows a modal for each. The
 * main process blocks the turn on `ai:resolveApproval`, so only one request is
 * ever pending (turns are serial). Rendered once inside `AiPanel`.
 *
 * Three render modes by `toolName`:
 *  - `AskUserQuestion` — the model asks the user multiple-choice questions;
 *    answers go back in the `ai:resolveApproval` payload (`updatedInput`).
 *  - `ExitPlanMode` (plan mode) — readable plan with Approve / Request changes.
 *  - anything else — generic JSON approval with Allow / Allow always / Deny.
 */
export default function ApprovalModal() {
  const { t } = useTranslation();
  const [req, setReq] = useState<AiApprovalRequest | null>(null);
  // ExitPlanMode (plan mode) renders as a readable plan with Approve / Request
  // changes rather than the generic tool-call approval.
  const isExitPlan = req?.toolName === 'ExitPlanMode';
  // AskUserQuestion renders the question form; malformed questions fall back
  // to the generic approval view (better than trapping the turn).
  const questions = useMemo(
    () =>
      req?.toolName === 'AskUserQuestion'
        ? parseAskUserQuestions(req.input)
        : null,
    [req]
  );
  const [selections, setSelections] = useState<
    Record<string, AskUserSelection>
  >({});
  // Plan-mode feedback: forwarded to the model as the deny message when the
  // user picks "Request changes" (previously a silent bare deny).
  const [planNote, setPlanNote] = useState('');

  useEffect(() => {
    const off = ipcApi.onAiApprovalRequest((r) => setReq(r));
    return off;
  }, []);

  // Fresh selections per new question request; fresh note per new request.
  useEffect(() => {
    setSelections(questions ? emptyAskUserSelections(questions) : {});
    setPlanNote('');
  }, [questions, req]);

  const resolve = (
    decision: ApprovalDecision,
    answers?: AskUserAnswers,
    note?: string
  ) => {
    if (!req) return;
    const id = req.reqId;
    setReq(null);
    void ipcApi.aiResolveApproval(id, decision, answers, note);
  };

  if (req && questions) {
    const answers = buildAskUserAnswers(questions, selections);
    return (
      <Dialog open onClose={() => resolve('deny')} fullWidth maxWidth="sm">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <QuestionAnswerIcon color="primary" />
          {t('aiQuestionTitle')}
        </DialogTitle>
        <DialogContent>
          <AskUserQuestionForm
            questions={questions}
            selections={selections}
            onChange={(question, next) =>
              setSelections((prev) => ({ ...prev, [question]: next }))
            }
          />
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => resolve('deny')}>
            {t('aiDeny')}
          </Button>
          <Button
            variant="contained"
            disabled={answers === null}
            onClick={() => answers && resolve('allow', answers)}
          >
            {t('aiQuestionSubmit')}
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

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
            {isExitPlan ? (
              <TextField
                size="small"
                multiline
                minRows={2}
                maxRows={5}
                fullWidth
                placeholder={t('aiPlanFeedback')}
                value={planNote}
                onChange={(e) => setPlanNote(e.target.value)}
              />
            ) : null}
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button
          color="inherit"
          onClick={() =>
            resolve(
              'deny',
              undefined,
              isExitPlan && planNote.trim() ? planNote.trim() : undefined
            )
          }
        >
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
