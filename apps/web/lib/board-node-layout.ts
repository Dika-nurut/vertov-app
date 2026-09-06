/**
 * Shared dimensions for generic board cards and pure spawn planning.
 *
 * The default card must fit its own warning state: a fresh generate node
 * renders a one-line invalid banner (~284px tall in total), and a node with
 * takes stacks the invalid + rerun banners (~301px). At 280px both banners
 * overflowed below the card border (measured via the canvas probe). 320 keeps
 * the 1:1 default aspect with headroom for a two-line banner.
 */
export const BOARD_NODE_W = 320;
export const BOARD_NODE_H = 320;
