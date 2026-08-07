export function avatarPath(variantId: string): string {
  return `/assets/characters/avatars/${variantId}.png`;
}

export function prefixedAvatarPath(variantId: string): string {
  return import.meta.env.BASE_URL + avatarPath(variantId).replace(/^\//, "");
}
