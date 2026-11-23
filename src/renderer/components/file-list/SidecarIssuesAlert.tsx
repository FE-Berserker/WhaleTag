import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Stack, Typography } from '@mui/material';

import type { SidecarIssue } from '../../../shared/ipc-types';
import { useConfirm } from '-/components/ConfirmDialogProvider';

export type CorruptSidecarIssue = Extract<SidecarIssue, { kind: 'corrupt' }>;

/** Persistent sidecar health warning, exported for focused component tests. */
export function SidecarIssuesAlert({
  issues,
  readOnly,
  onNavigate,
  onRecover,
}: {
  issues: SidecarIssue[];
  readOnly: boolean;
  onNavigate: (dirPath: string) => void;
  onRecover: (issue: CorruptSidecarIssue) => Promise<void>;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [pendingDir, setPendingDir] = useState<string | null>(null);
  if (issues.length === 0) return null;
  return (
    <Alert severity="warning" sx={{ borderRadius: 0 }} data-testid="sidecar-issues-warning">
      <Typography variant="body2">
        {t('sidecarIssuesWarning', { count: issues.length })}
      </Typography>
      <Stack spacing={0.5} sx={{ mt: 1 }}>
        {issues.map((issue) => (
          <Stack
            key={`${issue.dirPath}:${issue.kind}`}
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
          >
            <Button
              size="small"
              color="inherit"
              onClick={() => onNavigate(issue.dirPath)}
              sx={{ justifyContent: 'flex-start', overflowWrap: 'anywhere' }}
            >
              {issue.dirPath}
            </Button>
            {issue.kind === 'corrupt' && !readOnly ? (
              <Button
                size="small"
                color="inherit"
                disabled={pendingDir !== null}
                onClick={async () => {
                  if (pendingDir !== null) return;
                  const approved = await confirm({
                    title: t('sidecarRecoverTitle'),
                    message: t('sidecarRecoverMessage', { dirPath: issue.dirPath }),
                    confirmLabel: t('sidecarRecoverAction'),
                    danger: true,
                  });
                  if (!approved) return;
                  setPendingDir(issue.dirPath);
                  try {
                    await onRecover(issue);
                  } finally {
                    setPendingDir(null);
                  }
                }}
              >
                {t('sidecarRecoverAction')}
              </Button>
            ) : null}
          </Stack>
        ))}
      </Stack>
    </Alert>
  );
}
