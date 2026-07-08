import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  Button,
  Divider,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';

import { setAiSettings } from '-/reducers/settings';
import type { RootState } from '-/reducers';
import type {
  ManagedMcpServer,
  McpServerConfig,
} from '../../../shared/ai-types';

type Transport = 'stdio' | 'sse' | 'http';

/** Parse a multiline `KEY=value` block into a record (mirrors the CLI env parser). */
function parseEnv(input: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let any = false;
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    any = true;
  }
  return any ? out : undefined;
}

/** Split a command-args string on whitespace (naive; no quoted args in v1). */
function parseArgs(input: string): string[] | undefined {
  const args = input.split(/\s+/).filter(Boolean);
  return args.length ? args : undefined;
}

/**
 * MCP server management (Claude CLI provider only). CRUD over
 * `settings.aiMcpServers`; enabled servers are passed to the SDK at process
 * start. No connectivity tester in v1 (would spawn processes).
 */
export default function AiMcpSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const servers = useSelector((s: RootState) => s.settings.aiMcpServers);

  const [name, setName] = useState('');
  const [transport, setTransport] = useState<Transport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [url, setUrl] = useState('');

  const resetForm = () => {
    setName('');
    setCommand('');
    setArgs('');
    setEnv('');
    setUrl('');
  };

  const add = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (servers.some((s) => s.name === trimmedName)) return;
    let config: McpServerConfig;
    if (transport === 'stdio') {
      if (!command.trim()) return;
      config = {
        type: 'stdio',
        command: command.trim(),
        args: parseArgs(args),
        env: parseEnv(env),
      };
    } else {
      if (!url.trim()) return;
      config = { type: transport, url: url.trim() };
    }
    const next: ManagedMcpServer[] = [
      ...servers,
      { name: trimmedName, config, enabled: true },
    ];
    dispatch(setAiSettings({ aiMcpServers: next }));
    resetForm();
  };

  const update = (i: number, patch: Partial<ManagedMcpServer>) => {
    const next = servers.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    dispatch(setAiSettings({ aiMcpServers: next }));
  };

  const remove = (i: number) => {
    dispatch(
      setAiSettings({ aiMcpServers: servers.filter((_, idx) => idx !== i) })
    );
  };

  return (
    <>
      <Divider sx={{ my: 1 }} />
      <Typography variant="subtitle2">{t('aiMcpTitle')}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
        {t('aiMcpHint')}
      </Typography>

      {servers.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('aiMcpEmpty')}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {servers.map((s, i) => (
            <Stack
              key={s.name}
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center' }}
            >
              <Switch
                size="small"
                checked={s.enabled}
                onChange={(e) => update(i, { enabled: e.target.checked })}
              />
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                {s.name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {s.config.type}
              </Typography>
              <Tooltip title={t('remove')}>
                <IconButton size="small" onClick={() => remove(i)}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>
      )}

      <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <TextField
            size="small"
            placeholder={t('aiMcpName')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select
            size="small"
            value={transport}
            onChange={(e) => setTransport(e.target.value as Transport)}
            sx={{ minWidth: 100 }}
          >
            <MenuItem value="stdio">stdio</MenuItem>
            <MenuItem value="sse">sse</MenuItem>
            <MenuItem value="http">http</MenuItem>
          </Select>
        </Stack>
        {transport === 'stdio' ? (
          <>
            <TextField
              size="small"
              placeholder={t('aiMcpCommand')}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            <TextField
              size="small"
              placeholder={t('aiMcpArgs')}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
            <TextField
              size="small"
              multiline
              minRows={2}
              placeholder={'API_KEY=...'}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            />
          </>
        ) : (
          <TextField
            size="small"
            placeholder="https://…/mcp"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          sx={{ alignSelf: 'flex-start' }}
          onClick={add}
        >
          {t('aiMcpAdd')}
        </Button>
      </Box>
    </>
  );
}
