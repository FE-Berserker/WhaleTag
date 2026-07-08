import { useTranslation } from 'react-i18next';
import { Chip, Stack, Typography } from '@mui/material';
import LabelIcon from '@mui/icons-material/LabelOutlined';

interface TagFilterBarProps {
  tags: string[];
  activeTag: string | null;
  onToggle: (tag: string) => void;
}

/**
 * Horizontal chip bar of every tag present in the current directory. Clicking a
 * chip toggles filtering the list to files carrying that tag. Hidden when there
 * are no tags.
 */
export default function TagFilterBar({
  tags,
  activeTag,
  onToggle,
}: TagFilterBarProps) {
  const { t } = useTranslation();
  if (tags.length === 0) return null;
  return (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        gap: 0.5,
        px: 2,
        py: 0.5,
        borderBottom: 1,
        borderColor: 'divider',
        flexWrap: 'wrap',
        maxHeight: 56,
        overflow: 'auto',
      }}
    >
      <LabelIcon fontSize="small" sx={{ color: 'text.secondary' }} />
      <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
        {t('tags')}:
      </Typography>
      {tags.map((tag) => (
        <Chip
          key={tag}
          label={tag}
          size="small"
          color={activeTag === tag ? 'primary' : 'default'}
          variant={activeTag === tag ? 'filled' : 'outlined'}
          onClick={() => onToggle(tag)}
        />
      ))}
    </Stack>
  );
}
