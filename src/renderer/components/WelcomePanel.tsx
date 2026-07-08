import { useTranslation } from 'react-i18next';
import { Box, Button, Stack, Typography } from '@mui/material';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import logo from '-/assets/logo.png';

interface WelcomePanelProps {
  onAddLocation: () => void;
}

/** Empty state shown when no location is configured yet. */
export default function WelcomePanel({ onAddLocation }: WelcomePanelProps) {
  const { t } = useTranslation();
  return (
    <Stack
      sx={{
        flex: 1,
        p: 4,
        textAlign: 'center',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Box
        component="img"
        src={logo}
        alt="WhaleTag"
        sx={{ width: 96, height: 96 }}
      />
      <Typography variant="h5" sx={{ mt: 2 }}>
        {t('welcomeTitle')}
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 420 }}>
        {t('welcomeHint')}
      </Typography>
      <Button
        variant="contained"
        size="large"
        startIcon={<CreateNewFolderIcon />}
        sx={{ mt: 3 }}
        onClick={onAddLocation}
      >
        {t('addLocation')}
      </Button>
    </Stack>
  );
}
