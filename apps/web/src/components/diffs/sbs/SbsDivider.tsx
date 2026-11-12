import {
  SBS_DIVIDER_WIDTH,
  sbsVisibleConnectors,
  sbsVisibleFoldLinks,
  sbsVisibleMoveShapes,
  type SbsConnectorInput,
} from "./sbsConnectors";
import type { SbsMoveLayer } from "./sbsMoves";

function foldLinkPath(left: number, right: number): string {
  const third = SBS_DIVIDER_WIDTH / 3;
  return `M0,${left}C${third},${left - 3} ${2 * third},${right + 3} ${SBS_DIVIDER_WIDTH},${right}`;
}

/**
 * The centre strip: one filled band per change, each fold's wave carried across, and on top the
 * moves: a band between a block's two places in this file, or a wedge where it leaves it.
 */
export function SbsDivider({
  showConnectors,
  moves,
  ...geometry
}: SbsConnectorInput & {
  readonly showConnectors: boolean;
  readonly moves: SbsMoveLayer | null;
}) {
  const connectors = showConnectors
    ? sbsVisibleConnectors(moves ? { ...geometry, movedChanges: moves.movedChanges } : geometry)
    : [];
  const moveShapes = showConnectors && moves ? sbsVisibleMoveShapes({ ...geometry, moves }) : [];
  const foldLinks = sbsVisibleFoldLinks(geometry);
  return (
    <svg
      className="sbs-divider shrink-0"
      width={SBS_DIVIDER_WIDTH}
      height="100%"
      aria-hidden="true"
      data-sbs-divider=""
    >
      {connectors.map((connector) => (
        <path
          key={connector.change}
          d={connector.path}
          className="sbs-connector"
          data-kind={connector.kind}
          data-sbs-connector={connector.change}
        />
      ))}
      {moveShapes.map((shape) => (
        <path
          key={shape.id}
          d={shape.path}
          className="sbs-move-shape"
          data-kind={shape.kind}
          data-sbs-move-shape={shape.id}
        />
      ))}
      {foldLinks.map((link) => (
        <g key={link.fold} className="sbs-fold-link" data-sbs-fold={link.fold}>
          <path d={foldLinkPath(link.left, link.right)} className="sbs-fold-link-hit" />
          <path d={foldLinkPath(link.left, link.right)} className="sbs-fold-link-line" />
        </g>
      ))}
    </svg>
  );
}
