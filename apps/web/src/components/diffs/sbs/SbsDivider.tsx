import {
  SBS_DIVIDER_WIDTH,
  sbsVisibleConnectors,
  sbsVisibleFoldLinks,
  type SbsConnectorInput,
} from "./sbsConnectors";

function foldLinkPath(left: number, right: number): string {
  const third = SBS_DIVIDER_WIDTH / 3;
  return `M0,${left}C${third},${left - 3} ${2 * third},${right + 3} ${SBS_DIVIDER_WIDTH},${right}`;
}

/** The centre strip: one filled band per change, and each fold's wave carried across. */
export function SbsDivider(
  props: SbsConnectorInput & { readonly showConnectors: boolean },
) {
  const connectors = props.showConnectors ? sbsVisibleConnectors(props) : [];
  const foldLinks = sbsVisibleFoldLinks(props);
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
      {foldLinks.map((link) => (
        <g key={link.fold} className="sbs-fold-link" data-sbs-fold={link.fold}>
          <path d={foldLinkPath(link.left, link.right)} className="sbs-fold-link-hit" />
          <path d={foldLinkPath(link.left, link.right)} className="sbs-fold-link-line" />
        </g>
      ))}
    </svg>
  );
}
