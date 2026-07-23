import { useTranslation } from 'react-i18next';
import {
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import type { AskUserQuestionItem } from '../../../shared/ai-types';
import type { AskUserSelection } from './askUserAnswers';

interface AskUserQuestionFormProps {
  questions: AskUserQuestionItem[];
  selections: Record<string, AskUserSelection>;
  onChange: (question: string, next: AskUserSelection) => void;
}

/**
 * Renders the Claude CLI `AskUserQuestion` questions: a chip header, the
 * question text, and one choice list per question — radio for single-select,
 * checkboxes for multi-select — plus the built-in free-text "Other" choice
 * (per the SDK contract, the tool schema never includes one; the host adds
 * it and returns the typed text as the answer value).
 */
export default function AskUserQuestionForm({
  questions,
  selections,
  onChange,
}: AskUserQuestionFormProps) {
  const { t } = useTranslation();
  return (
    <Stack spacing={2.5}>
      {questions.map((q) => {
        const sel = selections[q.question] ?? {
          selected: [],
          otherChecked: false,
          other: '',
        };
        const set = (next: Partial<AskUserSelection>) =>
          onChange(q.question, { ...sel, ...next });
        return (
          <Box key={q.question}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
              {q.header ? (
                <Chip size="small" color="primary" variant="outlined" label={q.header} />
              ) : null}
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {q.question}
              </Typography>
            </Stack>
            {q.multiSelect ? (
              <Stack spacing={0}>
                {q.options.map((o) => (
                  <FormControlLabel
                    key={o.label}
                    control={
                      <Checkbox
                        size="small"
                        checked={sel.selected.includes(o.label)}
                        onChange={(e) =>
                          set({
                            selected: e.target.checked
                              ? [...sel.selected, o.label]
                              : sel.selected.filter((l) => l !== o.label),
                          })
                        }
                      />
                    }
                    label={
                      <>
                        <Typography variant="body2">{o.label}</Typography>
                        {o.description ? (
                          <Typography variant="caption" color="text.secondary">
                            {o.description}
                          </Typography>
                        ) : null}
                      </>
                    }
                  />
                ))}
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={sel.otherChecked}
                      onChange={(e) => set({ otherChecked: e.target.checked })}
                    />
                  }
                  label={t('aiQuestionOther')}
                />
              </Stack>
            ) : (
              <RadioGroup
                value={sel.otherChecked ? '__other__' : sel.selected[0] ?? ''}
                onChange={(e) => {
                  if (e.target.value === '__other__') {
                    set({ selected: [], otherChecked: true });
                  } else {
                    set({ selected: [e.target.value], otherChecked: false });
                  }
                }}
              >
                {q.options.map((o) => (
                  <FormControlLabel
                    key={o.label}
                    value={o.label}
                    control={<Radio size="small" />}
                    label={
                      <>
                        <Typography variant="body2">{o.label}</Typography>
                        {o.description ? (
                          <Typography variant="caption" color="text.secondary">
                            {o.description}
                          </Typography>
                        ) : null}
                      </>
                    }
                  />
                ))}
                <FormControlLabel
                  value="__other__"
                  control={<Radio size="small" />}
                  label={t('aiQuestionOther')}
                />
              </RadioGroup>
            )}
            {sel.otherChecked ? (
              <TextField
                size="small"
                fullWidth
                autoFocus
                placeholder={t('aiQuestionOtherPlaceholder')}
                value={sel.other}
                onChange={(e) => set({ other: e.target.value })}
                sx={{ mt: 0.5, ml: 4 }}
              />
            ) : null}
          </Box>
        );
      })}
    </Stack>
  );
}
