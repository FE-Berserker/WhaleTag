import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Tooltip,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import RestoreIcon from '@mui/icons-material/Restore';
import { useTranslation } from 'react-i18next';
import { ipcApi } from '-/services/ipc-api';
import type { RevisionInfo } from '../../shared/extension-types';

interface RevisionHistoryDialogProps {
  filePath: string;
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
}

export default function RevisionHistoryDialog({
  filePath,
  open,
  onClose,
  onRestored,
}: RevisionHistoryDialogProps) {
  const { t } = useTranslation();
  const [revisions, setRevisions] = useState<RevisionInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    ipcApi
      .listRevisions(filePath)
      .then((revs) => {
        setRevisions(revs);
      })
      .catch(() => {
        setRevisions([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, filePath]);

  const handleRestore = async (revisionPath: string) => {
    try {
      await ipcApi.restoreRevision(filePath, revisionPath);
      onRestored();
      onClose();
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(t('revisionRestoreError', { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  const handleDelete = async (revisionPath: string) => {
    try {
      await ipcApi.deleteRevision(revisionPath);
      setRevisions((prev) => prev.filter((r) => r.path !== revisionPath));
    } catch {
      // ignore
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('revisionHistory')}</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <ListItemText primary={t('loading')} />
        ) : revisions.length === 0 ? (
          <ListItemText primary={t('noRevisions')} />
        ) : (
          <List dense>
            {revisions.map((rev) => (
              <ListItem
                key={rev.path}
                secondaryAction={
                  <>
                    <Tooltip title={t('restore')}>
                      <IconButton
                        edge="end"
                        onClick={() => handleRestore(rev.path)}
                      >
                        <RestoreIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t('delete')}>
                      <IconButton
                        edge="end"
                        onClick={() => handleDelete(rev.path)}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Tooltip>
                  </>
                }
              >
                <ListItemText
                  primary={new Date(rev.timestamp).toLocaleString()}
                  secondary={t('revisionSize', { size: formatBytes(rev.size) })}
                />
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}
