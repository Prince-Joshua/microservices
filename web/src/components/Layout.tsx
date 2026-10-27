import { Link as RouterLink, NavLink, Outlet, useNavigate } from "react-router-dom";
import { Badge, Box, Button, Container, Flex, HStack, Link, Text } from "@chakra-ui/react";
import { LuShoppingCart } from "react-icons/lu";
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

  return (
    <Flex direction="column" minH="100vh">
      <Box as="header" bg="bg" borderBottomWidth="1px" position="sticky" top="0" zIndex="sticky">
        <Container maxW={layout.maxWidth}>
          <Flex align="center" justify="space-between" py="3" gap="4" wrap="wrap">
            <HStack gap="6" wrap="wrap">
              <Link asChild fontWeight="bold" fontSize="lg" color="brand.fg" _hover={{ textDecoration: "none" }}>
                <RouterLink to="/">Shopfront</RouterLink>
              </Link>
              <HStack gap="4" wrap="wrap">
                <NavItem to="/" end>
                  Products
                </NavItem>
                {user && <NavItem to="/orders">Orders</NavItem>}
                {isAdmin && <NavItem to="/admin/products">Manage products</NavItem>}
                {isAdmin && <NavItem to="/admin/users">Users</NavItem>}
              </HStack>
            </HStack>

            <HStack gap="2">
              <Button variant="ghost" size="sm" onClick={() => navigate("/cart")} aria-label="Cart">
                <LuShoppingCart />
                Cart
                {count > 0 && (
                  <Badge colorPalette="brand" variant="solid" borderRadius="full">
                    {count}
                  </Badge>
                )}
              </Button>
              <ColorModeButton />
              {user ? (
                <>
                  <Link asChild fontSize="sm" color="fg.muted">
                    <RouterLink to="/account">{user.name}</RouterLink>
                  </Link>
                  {isAdmin && (
                    <Badge colorPalette="purple" variant="subtle">
                      admin
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      logout();
                      navigate("/");
                    }}
                  >
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
          </Flex>
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
