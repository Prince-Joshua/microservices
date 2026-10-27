import { useEffect, useState } from "react";
import { Box, Image } from "@chakra-ui/react";
import { LuImage } from "react-icons/lu";

/**
 * Shows a product image from a link. Falls back to a neutral placeholder when
 * there is no link or the link fails to load, so a broken URL never leaves a hole.
 */
export function ProductImage({
  src,
  alt,
  ratio = 4 / 3,
  size,
  rounded = "md",
}: {
  src?: string;
  alt: string;
  /** Width / height. Ignored when `size` is set. */
  ratio?: number;
  /** Fixed square size (Chakra size token), e.g. "10" for a thumbnail. */
  size?: string;
  rounded?: string;
}) {
  const [failed, setFailed] = useState(false);

  // A new link gets a fresh chance to load.
  useEffect(() => setFailed(false), [src]);

  const dims = size ? { w: size, h: size, flexShrink: 0 } : { w: "full", aspectRatio: ratio };

  return (
    <Box
      {...dims}
      bg="bg.muted"
      color="fg.subtle"
      rounded={rounded}
      overflow="hidden"
      display="flex"
      alignItems="center"
      justifyContent="center"
    >
      {src && !failed ? (
        <Image
          src={src}
          alt={alt}
          w="full"
          h="full"
          objectFit="cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <LuImage size={size ? 16 : 32} aria-label="No image" />
      )}
    </Box>
  );
}
