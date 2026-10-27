import type { ReactNode } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "../../theme";
import { ColorModeProvider } from "./color-mode";
import { Toaster } from "./toaster";

export function Provider({ children }: { children: ReactNode }) {
  return (
    <ChakraProvider value={system}>
      <ColorModeProvider>
        {children}
        <Toaster />
      </ColorModeProvider>
    </ChakraProvider>
  );
}
