"""The extension zip has the layout the platform needs (no platform required)."""
import json, os, re, sys, tempfile, unittest, zipfile
import xml.etree.ElementTree as ElementTree

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
EXTENSION = os.path.join(ROOT, "extension")
sys.path.insert(0, EXTENSION)
from thingworx_package import build_extension_zip, entity_xml, merge_entity, read_metadata   # noqa: E402
BUNDLE = os.path.join(ROOT, "ui", "dist", "explorer", "main.js")


@unittest.skipUnless(os.path.isfile(BUNDLE), "build the UI first: cd ui && npm run build")
class ExtensionZip(unittest.TestCase):
    """The _json zip; ExtensionZipWithXmlEntities runs the same checks on the _xml zip."""
    entity_format = "json"

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.path = build_extension_zip(EXTENSION, cls.directory.name, entity_format=cls.entity_format,
                                       extra_files={"ui/se-common/se-elements.js": BUNDLE})
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

    def test_the_zip_name_ends_with_the_entity_format(self):
        self.assertTrue(os.path.basename(self.path).endswith(f"_{self.entity_format}.zip"), self.path)

    def test_entities_are_merged_with_the_mashup_content_inside(self):
        names = self.archive.namelist()
        self.assertEqual(sorted(name for name in names if name.startswith("Entities/")),
                         [f"Entities/Mashups/SE.Explorer.{self.entity_format}", f"Entities/Projects/SolutionExplorer.{self.entity_format}"])
        self.assertFalse([name for name in names if ".mp." in name], "split files must be merged")
        self.assertIn("se-explorer", self.archive.read(f"Entities/Mashups/SE.Explorer.{self.entity_format}").decode())

    def test_the_project_carries_its_package_version(self):
        name, version = read_metadata(self.path)
        self.assertIn(version, self.archive.read(f"Entities/Projects/SolutionExplorer.{self.entity_format}").decode())

    def test_runtime_loader_name_is_unique_to_this_extension(self):
        runtime = self.archive.read("ui/se-explorer/se-explorer.runtime.js").decode()
        self.assertIn("__seLoadElements", runtime)
        self.assertNotIn("__cmLoadElements", runtime)


class ExtensionZipWithXmlEntities(ExtensionZip):
    entity_format = "xml"

    def test_the_entity_xml_is_well_formed_and_holds_what_the_json_holds(self):
        mashup = ElementTree.fromstring(self.archive.read("Entities/Mashups/SE.Explorer.xml")).find("Mashups/Mashup")
        self.assertEqual(mashup.get("name"), "SE.Explorer")
        self.assertEqual(mashup.get("projectName"), "SolutionExplorer")
        self.assertEqual(mashup.get("aspect.isResponsive"), "true")
        source = os.path.join(EXTENSION, "Entities", "Mashups", "SE.Explorer")
        self.assertEqual(json.loads(mashup.find("mashupContent").text), json.loads(json.loads(merge_entity(source, "SE.Explorer"))
                                                                                  ["Mashups"]["Mashup"][0]["mashupContent"]))
        project = ElementTree.fromstring(self.archive.read("Entities/Projects/SolutionExplorer.xml")).find("Projects/Project")
        self.assertEqual(project.get("packageVersion"), read_metadata(self.path)[1])
        self.assertEqual(project.get("projectName"), "SolutionExplorer")


class EntityXml(unittest.TestCase):
    def test_text_that_would_end_a_cdata_section_or_break_an_attribute_survives(self):
        odd_description = 'a "quote" & <tag>\nline'
        document = {"Mashups": {"Mashup": [{"name": "Lab.Odd", "description": odd_description, "aspects": {},
                                            "mashupContent": '{"text": "]]>"}', "parameterDefinitions": {}}]}}
        mashup = ElementTree.fromstring(entity_xml("Mashups", json.dumps(document).encode())).find("Mashups/Mashup")
        self.assertEqual(mashup.get("description"), odd_description)
        self.assertEqual(mashup.find("mashupContent").text, '{"text": "]]>"}')

    def test_a_kind_without_a_checked_xml_form_is_refused(self):
        with self.assertRaises(ValueError):
            entity_xml("Things", b'{"Things": {"Thing": [{"name": "Lab.T"}]}}')


if __name__ == "__main__":
    unittest.main()


def load_build_script():
    import importlib.util
    specification = importlib.util.spec_from_file_location("extension_build", os.path.join(EXTENSION, "build.py"))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


@unittest.skipUnless(os.path.isfile(os.path.join(ROOT, "ui", "dist", "explorer", "3rdpartylicenses.txt")), "run the production UI build first")
class ThirdPartyNotices(unittest.TestCase):
    """The licence notices of every runtime package travel in the bundle and in the zip."""

    @classmethod
    def setUpClass(cls):
        cls.build = load_build_script()
        cls.notices = cls.build.third_party_notices()

    def test_every_runtime_package_has_a_notice(self):
        listed = {line.split(":", 1)[1].strip() for line in self.notices.splitlines() if line.startswith("Package:")}
        for package_name in self.build.runtime_packages():
            self.assertIn(package_name, listed)
        for package_name in ("acorn", "@dagrejs/dagre", "@dagrejs/graphlib", "@angular/core", "rxjs", "tslib"):
            self.assertIn(package_name, listed)

    def test_the_bundle_starts_with_the_notices_as_one_comment(self):
        with tempfile.TemporaryDirectory() as directory:
            with open(self.build.bundle_with_notices(self.notices, directory), encoding="utf-8") as handle:
                bundle = handle.read()
        self.assertTrue(bundle.startswith("/*!\n"))
        comment_end = bundle.index("*/")
        self.assertIn("Package: acorn", bundle[:comment_end])
        self.assertIn("Package: @dagrejs/graphlib", bundle[:comment_end])
