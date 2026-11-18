"""The extension zip has the layout the platform needs (no platform required)."""
import os, re, tempfile, unittest, zipfile
from twxlab.extension import build_extension_zip, read_metadata

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
EXTENSION = os.path.join(ROOT, "extension")
BUNDLE = os.path.join(ROOT, "ui", "dist", "explorer", "main.js")


@unittest.skipUnless(os.path.isfile(BUNDLE), "build the UI first: cd ui && npm run build")
class ExtensionZip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.path = build_extension_zip(EXTENSION, cls.directory.name, extra_files={"ui/se-common/se-elements.js": BUNDLE})
        cls.archive = zipfile.ZipFile(cls.path)

    @classmethod
    def tearDownClass(cls):
        cls.archive.close()
        cls.directory.cleanup()

    def test_metadata_names_the_package_and_a_numeric_version(self):
        name, version = read_metadata(self.path)
        self.assertEqual(name, "SolutionExplorer")
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")

    def test_every_widget_file_in_metadata_is_in_the_zip(self):
        metadata = self.archive.read("metadata.xml").decode()
        names = set(self.archive.namelist())
        for widget, block in re.findall(r'<Widget name="([^"]+)">(.*?)</Widget>', metadata, re.S):
            for file_name in re.findall(r'file="([^"]+)"', block):
                folder = "ui/se-common/" if file_name == "se-elements.js" else f"ui/{widget}/"
                self.assertIn(folder + file_name, names)

    def test_entities_are_merged_json_with_the_mashup_content_inside(self):
        names = self.archive.namelist()
        self.assertIn("Entities/Mashups/SE.Explorer.json", names)
        self.assertIn("Entities/Projects/SolutionExplorer.json", names)
        self.assertFalse([name for name in names if ".mp." in name], "split files must be merged")
        self.assertIn("se-explorer", self.archive.read("Entities/Mashups/SE.Explorer.json").decode())

    def test_the_project_carries_its_package_version(self):
        self.assertIn("packageVersion", self.archive.read("Entities/Projects/SolutionExplorer.json").decode())

    def test_runtime_loader_name_is_unique_to_this_extension(self):
        runtime = self.archive.read("ui/se-explorer/se-explorer.runtime.js").decode()
        self.assertIn("__seLoadElements", runtime)
        self.assertNotIn("__cmLoadElements", runtime)


if __name__ == "__main__":
    unittest.main()
