import { SvgIcon, type SxProps, type Theme } from '@mui/material';

/**
 * WhaleTag logo — inlined from `resources/logo.svg` (a blue rounded square with
 * a white bookmark and a whale-tail cutout). Vector, so it stays crisp at any
 * size; the frameless title bar renders it at 18px. Pass `sx` to size/color it.
 */
export default function LogoIcon({ sx }: { sx?: SxProps<Theme> }): JSX.Element {
  return (
    <SvgIcon viewBox="0 0 512 512" sx={sx}>
      <rect width="512" height="512" rx="110" fill="#007aff" />
      {/* bookmark */}
      <path
        d="M 196 120 L 316 120 A 24 24 0 0 1 340 144 L 340 380 L 256 320 L 172 380 L 172 144 A 24 24 0 0 1 196 120 Z"
        fill="#ffffff"
      />
      {/* whale-tail cutout */}
      <g fill="#007aff">
        <path d="M 256 300 C 256 260 252 228 246 204 C 240 180 236 170 236 164 C 236 154 244 148 256 148 C 268 148 276 154 276 164 C 276 170 272 180 266 204 C 260 228 256 260 256 300 Z" />
        <path d="M 256 170 C 256 170 226 142 196 146 C 172 149 160 168 160 168 C 160 168 180 178 204 184 C 228 190 256 190 256 190 Z" />
        <path d="M 256 170 C 256 170 286 142 316 146 C 340 149 352 168 352 168 C 352 168 332 178 308 184 C 284 190 256 190 256 190 Z" />
      </g>
    </SvgIcon>
  );
}
