import { Breadcrumbs, Link } from '@mui/material';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { joinPath } from '-/services/path-util';

interface Crumb {
  name: string;
  path: string;
}

function buildCrumbs(dirPath: string, rootPath: string): Crumb[] {
  if (!dirPath || !rootPath) return [];
  const normDir = dirPath.replace(/\\/g, '/');
  const normRoot = rootPath.replace(/\\/g, '/');
  if (!normDir.startsWith(normRoot)) {
    return [{ name: dirPath, path: dirPath }];
  }
  const rel = normDir.slice(normRoot.length).replace(/^\/+/, '');
  if (!rel) return [];
  const parts = rel.split('/').filter(Boolean);
  const crumbs: Crumb[] = [];
  let current = rootPath;
  for (const part of parts) {
    current = joinPath(current, part);
    crumbs.push({ name: part, path: current });
  }
  return crumbs;
}

/** Bread-crumb trail for the current directory inside the active location. */
export default function BreadcrumbNav() {
  const { currentLocation, currentDirectoryPath, navigateTo } =
    useCurrentLocationContext();

  if (!currentLocation) return null;

  const atRoot = currentDirectoryPath === currentLocation.path;
  const crumbs = atRoot
    ? []
    : buildCrumbs(currentDirectoryPath, currentLocation.path);

  return (
    <Breadcrumbs
      aria-label="breadcrumb"
      sx={{
        flex: 1,
        overflow: 'hidden',
        '& .MuiBreadcrumbs-ol': { flexWrap: 'nowrap' },
        '& .MuiBreadcrumbs-li': { whiteSpace: 'nowrap' },
      }}
    >
      <Link
        component="button"
        underline="hover"
        color={atRoot ? 'text.primary' : 'inherit'}
        sx={{ fontSize: 'inherit', cursor: 'pointer' }}
        onClick={() => navigateTo(currentLocation.path)}
      >
        {currentLocation.name}
      </Link>
      {crumbs.map((crumb) => (
        <Link
          key={crumb.path}
          component="button"
          underline="hover"
          color="inherit"
          sx={{ fontSize: 'inherit', cursor: 'pointer' }}
          onClick={() => navigateTo(crumb.path)}
        >
          {crumb.name}
        </Link>
      ))}
    </Breadcrumbs>
  );
}
