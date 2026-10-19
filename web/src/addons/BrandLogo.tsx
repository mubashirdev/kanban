import { BRAND } from "./brand";

export function BrandLogo({ size = 22 }: { size?: number }) {
  return <img src={BRAND.icons.svg} width={size} height={size} alt="" className="logo" style={{ borderRadius: size / 4 }} />;
}
