import { useEffect, useState } from "react";
import { Link as RouterLink, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Badge, Box, Button, Container, Flex, HStack, IconButton, Link, Separator, Stack, Text } from "@chakra-ui/react";
import { LuMenu, LuShoppingCart, LuX } from "react-icons/lu";
import { useAuth } from "../context/AuthContext";
import { useCart } from "../context/CartContext";
import { ColorModeButton } from "./ui/color-mode";
import { layout } from "../theme";

function NavItem({ to, children, end }: { to: string; children: string; end?: boolean }) {
  return (
    <Link asChild fontWeight="medium" color="fg.muted" _hover={{ color: "fg", textDecoration: "none" }}>
      <NavLink
        to={to}
        end={end}
        style={({ isActive }) => ({ color: isActive ? "var(--chakra-colors-brand-fg)" : undefined })}
      >
        {children}
      </NavLink>
    </Link>
  );
}

export function Layout() {
  const { user, isAdmin, logout } = useAuth();
  const { count } = useCart();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile menu whenever the page changes.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const signOut = () => {
    logout();
    navigate("/");
  };

  const cartButton = (
    <Button variant="ghost" size="sm" onClick={() => navigate("/cart")} aria-label="Cart">
      <LuShoppingCart />
      <Box as="span" display={{ base: "none", md: "inline" }}>
        Cart
      </Box>
      {count > 0 && (
        <Badge colorPalette="brand" variant="solid" borderRadius="full">
          {count}
        </Badge>
      )}
    </Button>
  );

  const navLinks = (
    <>
      <NavItem to="/" end>
        Products
      </NavItem>
      {user && <NavItem to="/orders">Orders</NavItem>}
      {isAdmin && <NavItem to="/admin/products">Manage products</NavItem>}
      {isAdmin && <NavItem to="/admin/users">Users</NavItem>}
    </>
  );

  return (
    <Flex direction="column" minH="100vh">
      <Box as="header" bg="bg" borderBottomWidth="1px" position="sticky" top="0" zIndex="sticky">
        <Container maxW={layout.maxWidth}>
          <Flex align="center" justify="space-between" py="3" gap="4">
            <HStack gap="6">
              <Link asChild fontWeight="bold" fontSize="lg" color="brand.fg" _hover={{ textDecoration: "none" }}>
                <RouterLink to="/">Shopfront</RouterLink>
              </Link>
              {/* Desktop navigation */}
              <HStack gap="4" display={{ base: "none", md: "flex" }}>
                {navLinks}
              </HStack>
            </HStack>

            {/* Desktop actions */}
            <HStack gap="2" display={{ base: "none", md: "flex" }}>
              {cartButton}
              <ColorModeButton />
              {user ? (
                <>
                  <Link asChild fontSize="sm" color="fg.muted" maxW="40" truncate>
                    <RouterLink to="/account">{user.name}</RouterLink>
                  </Link>
                  {isAdmin && (
                    <Badge colorPalette="purple" variant="subtle">
                      admin
                    </Badge>
                  )}
                  <Button size="sm" variant="outline" onClick={signOut}>
                    Sign out
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => navigate("/login")}>
                    Sign in
                  </Button>
                  <Button size="sm" colorPalette="brand" onClick={() => navigate("/register")}>
                    Create account
                  </Button>
                </>
              )}
            </HStack>

            {/* Mobile actions */}
            <HStack gap="1" display={{ base: "flex", md: "none" }}>
              {cartButton}
              <ColorModeButton />
              <IconButton
                variant="ghost"
                size="sm"
                aria-label={menuOpen ? "Close menu" : "Open menu"}
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                {menuOpen ? <LuX /> : <LuMenu />}
              </IconButton>
            </HStack>
          </Flex>

          {/* Mobile menu */}
          {menuOpen && (
            <Stack display={{ base: "flex", md: "none" }} gap="4" pb="4" pt="1" borderTopWidth="1px">
              <Stack gap="3" pt="3">
                {navLinks}
              </Stack>
              <Separator />
              {user ? (
                <Stack gap="3">
                  <HStack justify="space-between">
                    <Link asChild fontSize="sm" color="fg.muted" truncate>
                      <RouterLink to="/account">{user.name}</RouterLink>
                    </Link>
                    {isAdmin && (
                      <Badge colorPalette="purple" variant="subtle">
                        admin
                      </Badge>
                    )}
                  </HStack>
                  <Button size="sm" variant="outline" onClick={signOut}>
                    Sign out
                  </Button>
                </Stack>
              ) : (
                <HStack gap="2">
                  <Button flex="1" size="sm" variant="outline" onClick={() => navigate("/login")}>
                    Sign in
                  </Button>
                  <Button flex="1" size="sm" colorPalette="brand" onClick={() => navigate("/register")}>
                    Create account
                  </Button>
                </HStack>
              )}
            </Stack>
          )}
        </Container>
      </Box>

      <Container as="main" maxW={layout.maxWidth} py="8" flex="1">
        <Outlet />
      </Container>

      <Box as="footer" py="6" borderTopWidth="1px">
        <Container maxW={layout.maxWidth}>
          <Text fontSize="sm" color="fg.muted">
            Payments by Paystack · Orders are held for 30 minutes while awaiting payment
          </Text>
        </Container>
      </Box>
    </Flex>
  );
}
