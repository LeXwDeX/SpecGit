{
  description = "SpecGit - delivery binding and acceptance harness";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = f: nixpkgs.lib.genAttrs supportedSystems (system: f system);
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          inherit (pkgs) lib;
        in
        {
          default = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "specgit";
            version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./src
                ./bin
                ./schemas
                ./scripts
                ./test
                ./package.json
                ./pnpm-lock.yaml
                ./pnpm-workspace.yaml
                ./tsconfig.json
                ./build.js
                ./vitest.config.ts
                ./vitest.setup.ts
                ./eslint.config.js
              ];
            };

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              pnpm = pkgs.pnpm_9;
              fetcherVersion = 3;
              hash = "sha256-7mim5ZzN3u8aze54kPhrzoFT2fTog6/T4VeRlLxpCHA=";
            };

            nativeBuildInputs = with pkgs; [
              nodejs_22
              npmHooks.npmInstallHook
              pnpmConfigHook
              pnpm_9
            ];

            buildPhase = ''
              runHook preBuild

              pnpm run build

              runHook postBuild
            '';

            dontNpmPrune = true;

            meta = with pkgs.lib; {
              description = "Delivery binding and acceptance harness";
              homepage = "https://github.com/LeXwDeX/SpecGit";
              license = licenses.mit;
              maintainers = [ ];
              mainProgram = "specgit";
            };
          });
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/specgit";
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [
              nodejs_22
              pnpm_9
            ];

            shellHook = ''
              echo "SpecGit development environment"
              echo "Node version: $(node --version)"
              echo "pnpm version: $(pnpm --version)"
              echo "Run 'pnpm install' to install dependencies"
            '';
          };
        }
      );
    };
}
