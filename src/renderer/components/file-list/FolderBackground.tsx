import Box from '@mui/material/Box';

/**
 * Decorative `.whale/wsb.jpg` behind the current directory's file area.
 * It never receives input and stays behind normal content; the low opacity
 * keeps filenames, selection outlines and drag/drop affordances readable.
 */
export default function FolderBackground({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <Box
      aria-hidden="true"
      data-testid="folder-background"
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: -1,
        pointerEvents: 'none',
        backgroundImage: `url(${JSON.stringify(url)})`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center',
        backgroundSize: 'cover',
        opacity: (theme) => (theme.palette.mode === 'dark' ? 0.2 : 0.14),
      }}
    />
  );
}
