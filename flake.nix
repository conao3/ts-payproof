{
  description = "PayProof: an auditable invoice agent";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    treefmt-nix.url = "github:numtide/treefmt-nix";
  };
  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      imports = [ inputs.treefmt-nix.flakeModule ];
      perSystem =
        { pkgs, ... }:
        let
          node = pkgs.nodejs_26;
          pnpm = pkgs.pnpm;
          vp = pkgs.writeShellScriptBin "vp" ''
            root="$PWD"
            while [ ! -f "$root/pnpm-workspace.yaml" ]; do
              if [ "$root" = / ]; then exit 1; fi
              root="$(dirname "$root")"
            done
            if [ "$1" = install ]; then
              shift
              exec ${pnpm}/bin/pnpm install "$@"
            fi
            exec ${node}/bin/node "$root/node_modules/vite-plus/bin/vp" "$@"
          '';
        in
        {
          treefmt = {
            projectRootFile = "flake.nix";
            programs.nixfmt.enable = true;
          };
          devShells.default = pkgs.mkShell {
            packages = [
              node
              pnpm
              vp
              pkgs.gh
            ];
          };
          packages.default = pkgs.stdenv.mkDerivation {
            pname = "payproof";
            version = "0.1.0";
            src = pkgs.lib.cleanSource ./.;
            nativeBuildInputs = [
              node
              pnpm
              pkgs.pnpmConfigHook
              pkgs.makeWrapper
            ];
            pnpmDeps = pkgs.fetchPnpmDeps {
              pname = "payproof";
              version = "0.1.0";
              src = pkgs.lib.cleanSource ./.;
              inherit pnpm;
              fetcherVersion = 5;
              hash = "sha256-N61Q1HblYQEth3ucK3WWTc8UznNSxyJBPE56GxEIHM0=";
            };
            buildPhase = ''
              runHook preBuild
              pnpm codegen
              node node_modules/vite-plus/bin/vp build
              node node_modules/vite-plus/bin/vp pack
              runHook postBuild
            '';
            installPhase = ''
              mkdir -p $out/lib/payproof $out/bin
              cp -r dist node_modules scripts apps packages schema.graphql package.json $out/lib/payproof/
              makeWrapper ${node}/bin/node $out/bin/payproof --add-flags "$out/lib/payproof/scripts/start.ts"
            '';
            meta.mainProgram = "payproof";
          };
        };
    };
}
